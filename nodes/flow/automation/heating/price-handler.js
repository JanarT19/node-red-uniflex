/**
 * price-handler.js
 *
 * Reads electricity and gas spot prices from calendar (populated by price-fetcher nodes),
 * applies transport/tax surcharges and efficiencies, computes heat prices, and writes
 * series to the SQL calendar. Designed for 15-minute granularity (or the interval provided
 * by the source). Runs on trigger (e.g., daily inject).
 */

const https = require("https");
const http = require("http");
const ts = require("../../core/lib/timestamp.js");

const NODE_VERSION = "0.1.0";

module.exports = function (RED) {
    function PriceHandlerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.controller = RED.nodes.getNode(config.controller);
        node.elecSpotTitle = config.elecSpotTitle || "electricity.spot";
        node.gasSpotTitle = config.gasSpotTitle || "gas.spot";
        node.elecTransportTitle = config.elecTransportTitle || "electricity.transport_tax";
        node.gasTransportTitle = config.gasTransportTitle || "gas.transport_tax";
        node.elecHeatTitle = config.elecHeatTitle || "heat_price.electricity";
        node.gasHeatTitle = config.gasHeatTitle || "heat_price.gas";

        node.elecTransportDay = parseFloat(config.elecTransportDay || 0);
        node.elecTransportNight = parseFloat(config.elecTransportNight || 0);
        node.elecMonthlyCost1 = parseFloat(config.elecMonthlyCost1 || 0);
        node.elecMonthlyCost1Comment = config.elecMonthlyCost1Comment || "";
        node.elecMonthlyCost2 = parseFloat(config.elecMonthlyCost2 || 0);
        node.elecMonthlyCost2Comment = config.elecMonthlyCost2Comment || "";
        node.elecTax1 = parseFloat(config.elecTax1 || 0); // per kWh
        node.elecTax1Comment = config.elecTax1Comment || "";
        node.elecTax2 = parseFloat(config.elecTax2 || 0); // per kWh
        node.elecTax2Comment = config.elecTax2Comment || "";
        node.elecVat = parseFloat(config.elecVat || 0); // VAT percentage (e.g., 20 for 20%)
        node.dayStartHour = parseInt(config.dayStartHour || 7, 10); // local hour when day rate starts
        node.dayEndHour = parseInt(config.dayEndHour || 23, 10); // local hour when day rate ends (exclusive of night)
        node.useSummertime = config.useSummertime === true;
        node.holidaysTitle = config.holidaysTitle || "holiday";
        node.weekdaysActive = Array.isArray(config.weekdaysActive) ? config.weekdaysActive.map(Number) : [1, 2, 3, 4, 5]; // 0=Sun..6=Sat
        node.gasMonthlyCost1 = parseFloat(config.gasMonthlyCost1 || 0);
        node.gasMonthlyCost1Comment = config.gasMonthlyCost1Comment || "";
        node.gasMonthlyCost2 = parseFloat(config.gasMonthlyCost2 || 0);
        node.gasMonthlyCost2Comment = config.gasMonthlyCost2Comment || "";
        node.gasTransportPerM3 = parseFloat(config.gasTransportPerM3 || 0); // €/m³
        node.gasTransportPerM3Comment = config.gasTransportPerM3Comment || "";
        node.gasTax1PerM3 = parseFloat(config.gasTax1PerM3 || 0); // €/m³
        node.gasTax1PerM3Comment = config.gasTax1PerM3Comment || "";
        node.gasTax2PerM3 = parseFloat(config.gasTax2PerM3 || 0); // €/m³
        node.gasTax2PerM3Comment = config.gasTax2PerM3Comment || "";
        node.gasHeatingValuePerM3 = parseFloat(config.gasHeatingValuePerM3 || 10.0); // kWh/m³ (calorific value)
        node.gasVat = parseFloat(config.gasVat || 0); // VAT percentage

        node.copT1 = parseFloat(config.copT1 || 0);
        node.copV1 = parseFloat(config.copV1 || 1);
        node.copT2 = parseFloat(config.copT2 || 0);
        node.copV2 = parseFloat(config.copV2 || 1);
        node.ambientTempTitle = config.ambientTempTitle || "main.temp";
        node.boilerEff = parseFloat(config.boilerEff || 0.9);

        node.enableLogging = config.enableLogging !== false;
        node.debugTopics = (config.debugTopics || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        node.calendarTopic = config.calendarTopic || "calendar/price-handler";
        node.retryCount = parseInt(config.retryCount, 10) || 3;
        node.retryDelayMinutes = parseInt(config.retryDelayMinutes, 10) || 5;
        node.intervalMinutes = parseInt(config.intervalMinutes, 10) || 15; // spot price interval (was 60, now 15, may become 5)

        node.status({ fill: "grey", shape: "ring", text: "idle" });

        if (node.enableLogging) {
            node.log(`[price-handler v${NODE_VERSION}] Initialized | Elec title: ${node.elecSpotTitle} | Gas title: ${node.gasSpotTitle} | Calendar: ${node.calendarTopic}`);
        }

        const log = (msg, topic) => {
            if (!node.enableLogging) return;
            if (node.debugTopics.length === 0 || (topic && node.debugTopics.some((p) => topic.startsWith(p)))) {
                node.log(`[price-handler v${NODE_VERSION}] ${msg}`);
            }
        };

        const warn = (msg) => node.warn(`[price-handler] ${msg}`);
        const err = (msg) => node.error(`[price-handler] ${msg}`);

        function makeRequest(url, timeoutMs = 8000) {
            return new Promise((resolve, reject) => {
                const lib = url.startsWith("https") ? https : http;
                const req = lib.get(url, { timeout: timeoutMs }, (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        }
                        try {
                            const parsed = JSON.parse(data);
                            resolve(parsed);
                        } catch (e) {
                            reject(new Error(`Invalid JSON: ${e.message}`));
                        }
                    });
                });
                req.on("timeout", () => {
                    req.destroy(new Error("Request timeout"));
                });
                req.on("error", reject);
            });
        }

        // Check if timestamp is a holiday (using holiday events from calendar)
        function isHoliday(ts, holidayEvents) {
            const d = new Date(ts * 1000);
            const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
            // Check if any holiday event covers this date (events are stored as timestamp + duration)
            for (const evt of holidayEvents) {
                const evtDate = new Date(evt.timestamp * 1000);
                const evtDateStr = `${evtDate.getFullYear()}${String(evtDate.getMonth() + 1).padStart(2, "0")}${String(evtDate.getDate()).padStart(2, "0")}`;
                if (evtDateStr === dateStr) {
                    return true;
                }
            }
            return false;
        }

        function pickElecTransport(ts, transportDay, transportNight, dayStart, dayEnd, weekdaysActive, holidayEvents, useSummertime) {
            const d = new Date(ts * 1000);
            const dow = d.getDay(); // 0=Sun
            let hour = d.getHours();

            // Apply summertime offset if enabled (DST adds 1 hour)
            if (useSummertime) {
                // Check if we're in DST (Europe: last Sunday in March to last Sunday in October)
                const year = d.getFullYear();
                const marchLastSunday = new Date(year, 2, 31 - new Date(year, 2, 31).getDay(), 2, 0, 0, 0); // March 31, find last Sunday
                const octoberLastSunday = new Date(year, 9, 31 - new Date(year, 9, 31).getDay(), 3, 0, 0, 0); // October 31, find last Sunday
                const isDST = d >= marchLastSunday && d < octoberLastSunday;
                if (isDST) {
                    hour = (hour + 1) % 24; // Adjust hour for DST
                }
            }

            // Holidays use night rate
            if (isHoliday(ts, holidayEvents)) {
                return transportNight;
            }

            const isWeekend = dow === 0 || dow === 6;
            const weekdaySelected = weekdaysActive.includes(dow);
            // Weekend or non-selected weekdays use night rate
            if (isWeekend || !weekdaySelected) {
                return transportNight;
            }
            // Selected weekday: day vs night based on hour (with DST adjustment if enabled)
            if (hour >= dayStart && hour < dayEnd) {
                return transportDay;
            }
            return transportNight;
        }

        function applyTaxes(base, fixed, percent) {
            const pct = percent ? percent / 100 : 0;
            return base * (1 + pct) + fixed;
        }

        function interpCop(temp, t1, v1, t2, v2) {
            if (!Number.isFinite(temp) || !Number.isFinite(t1) || !Number.isFinite(t2) || !Number.isFinite(v1) || !Number.isFinite(v2)) {
                return 1; // safe fallback
            }
            if (t1 === t2) return v1;
            const ratio = (temp - t1) / (t2 - t1);
            return v1 + ratio * (v2 - v1);
        }

        function deleteRange(title, startTs, endTs, send) {
            // Send delete message to sql-calendar node (fire-and-forget)
            log(`Deleting calendar series: ${title} from ${startTs} to ${endTs}`);
            send({
                topic: node.calendarTopic,
                mode: "delete",
                title: title,
                start: startTs,
                end: endTs
            });
        }

        async function writeSeries(title, points, intervalSeconds, send) {
            // Send create messages to sql-calendar node with small delays to avoid duplicate detection
            // intervalSeconds=0 means step values (valid until next value)
            const isStepValue = intervalSeconds === 0;
            log(`Writing calendar series: ${title} with ${points.length} points (${isStepValue ? "step" : "interval=" + intervalSeconds + "s"})`);
            for (let i = 0; i < points.length; i++) {
                const p = points[i];
                const msg = {
                    topic: node.calendarTopic,
                    mode: "create",
                    title: title,
                    timestamp: p.timestamp,
                    value: p.value
                };
                if (!isStepValue) {
                    msg.duration = intervalSeconds;
                }
                send(msg);
                // Add tiny delay every 10 messages to avoid overwhelming sql-calendar's duplicate detection
                if ((i + 1) % 10 === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            }
        }

        async function runOnce(send) {
            const now = new Date();
            const nowTs = Math.floor(now.getTime() / 1000);
            // Wide window to find all available spot data (search from 3 days ago to 3 days ahead)
            const searchStartTs = nowTs - 72 * 3600;
            const searchEndTs = nowTs + 72 * 3600;

            // Calendar API is always on localhost (same machine as Node-RED)
            const host = "localhost";
            const port = 80;

            node.status({ fill: "blue", shape: "dot", text: "reading elec spot..." });

            // Read electricity spot prices first - this drives the time window
            let elecPoints = [];
            try {
                const elecQueryParams = new URLSearchParams({
                    title: node.elecSpotTitle,
                    start: searchStartTs.toString(),
                    end: searchEndTs.toString()
                });
                const elecResp = await makeRequest(`http://${host}:${port}/calendar?${elecQueryParams.toString()}`, 8000);
                if (Array.isArray(elecResp)) {
                    elecPoints = elecResp
                        .filter((p) => p.timestamp !== undefined && p.value !== undefined)
                        .map((p) => ({
                            timestamp: p.timestamp > 1e12 ? Math.floor(p.timestamp / 1000) : Math.floor(p.timestamp),
                            value: Number(p.value)
                        }))
                        .filter((p) => Number.isFinite(p.value))
                        .sort((a, b) => a.timestamp - b.timestamp);
                    log(`Loaded ${elecPoints.length} electricity spot price points from calendar`);
                } else {
                    throw new Error(`Calendar read failed: response not an array`);
                }
            } catch (e) {
                throw new Error(`Failed to read electricity prices from calendar: ${e.message}`);
            }

            if (elecPoints.length === 0) {
                throw new Error("No electricity spot data available");
            }

            // Window: 48 hours ending at last available spot timestamp (+interval to include last point's duration)
            const intervalSeconds = node.intervalMinutes * 60;
            const endTs = elecPoints[elecPoints.length - 1].timestamp + intervalSeconds;
            const startTs = endTs - 48 * 3600; // 48 hours before end

            // Filter elecPoints to only include those within our 48h window
            elecPoints = elecPoints.filter((p) => p.timestamp >= startTs && p.timestamp < endTs);

            log(`Window: 48h ending at last spot | ${startTs} to ${endTs} (${Math.round((endTs - startTs) / 3600)}h) | ${elecPoints.length} points in range`);

            // Read gas spot prices from calendar
            // Gas prices are step values (rarely change), so look back 30 days to find the current valid price
            let gasPoints = [];
            const gasLookbackStart = nowTs - 30 * 24 * 3600; // 30 days back
            try {
                const gasQueryParams = new URLSearchParams({
                    title: node.gasSpotTitle,
                    start: gasLookbackStart.toString(),
                    end: endTs.toString()
                });
                const gasResp = await makeRequest(`http://${host}:${port}/calendar?${gasQueryParams.toString()}`, 8000);
                if (Array.isArray(gasResp)) {
                    gasPoints = gasResp
                        .filter((p) => p.timestamp !== undefined && p.value !== undefined)
                        .map((p) => ({
                            timestamp: p.timestamp > 1e12 ? Math.floor(p.timestamp / 1000) : Math.floor(p.timestamp),
                            value: Number(p.value)
                        }))
                        .filter((p) => Number.isFinite(p.value))
                        .sort((a, b) => a.timestamp - b.timestamp);
                    log(`Loaded ${gasPoints.length} gas spot price points from calendar (30d lookback)`);
                } else {
                    throw new Error(`Calendar read failed: response not an array`);
                }
            } catch (e) {
                throw new Error(`Failed to read gas prices from calendar: ${e.message}`);
            }

            if (elecPoints.length === 0) {
                throw new Error("No electricity price data in window");
            }
            if (gasPoints.length === 0) {
                node.warn(`[price-handler v${NODE_VERSION}] No gas price found (30d lookback) - gas calculations skipped`);
            }

            // Read holidays from calendar (should be populated by holidays-fetcher node)
            let holidayEvents = [];
            if (node.holidaysTitle) {
                try {
                    const queryParams = new URLSearchParams({
                        title: node.holidaysTitle,
                        start: startTs.toString(),
                        end: endTs.toString(),
                        events: "true"
                    });
                    const calendarResp = await makeRequest(`http://${host}:${port}/calendar?${queryParams.toString()}`, 8000);
                    if (Array.isArray(calendarResp)) {
                        holidayEvents = calendarResp;
                        if (holidayEvents.length > 0) {
                            log(`Loaded ${holidayEvents.length} holiday events from calendar`);
                        }
                    }
                } catch (e) {
                    warn(`Failed to read holidays from calendar: ${e.message}`);
                }
            }

            // Read ambient temperature forecast from calendar for COP interpolation
            let ambientPoints = [];
            if (node.ambientTempTitle) {
                try {
                    const queryParams = new URLSearchParams({
                        title: node.ambientTempTitle,
                        start: startTs.toString(),
                        end: endTs.toString()
                    });
                    const calendarResp = await makeRequest(`http://${host}:${port}/calendar?${queryParams.toString()}`, 8000);
                    if (Array.isArray(calendarResp)) {
                        ambientPoints = calendarResp;
                        if (ambientPoints.length > 0) {
                            log(`Loaded ${ambientPoints.length} ambient temperature points from calendar`);
                        } else {
                            warn(`No ambient temperature data found for ${node.ambientTempTitle}`);
                        }
                    }
                } catch (e) {
                    warn(`Failed to read ambient temperature from calendar: ${e.message}`);
                }
            }

            const elecTransportPoints = [];
            const gasTransportPoints = [];
            const elecHeatPoints = [];
            const gasHeatPoints = [];

            const boilerEff = node.boilerEff > 0 ? node.boilerEff : 0.9;

            // Helper to get ambient temperature at a specific timestamp (or interpolate/extrapolate)
            function getAmbientAtTimestamp(ts) {
                if (ambientPoints.length === 0) {
                    // No forecast data: use average of T1 and T2
                    return (node.copT1 + node.copT2) / 2;
                }
                // Find closest point or interpolate
                const sorted = [...ambientPoints].sort((a, b) => a.timestamp - b.timestamp);
                if (ts <= sorted[0].timestamp) {
                    return sorted[0].value; // Extrapolate using first value
                }
                if (ts >= sorted[sorted.length - 1].timestamp) {
                    return sorted[sorted.length - 1].value; // Extrapolate using last value
                }
                // Interpolate between two points
                for (let i = 0; i < sorted.length - 1; i++) {
                    if (ts >= sorted[i].timestamp && ts < sorted[i + 1].timestamp) {
                        const t0 = sorted[i].timestamp;
                        const t1 = sorted[i + 1].timestamp;
                        const v0 = sorted[i].value;
                        const v1 = sorted[i + 1].value;
                        if (t1 === t0) return v0;
                        const ratio = (ts - t0) / (t1 - t0);
                        return v0 + ratio * (v1 - v0);
                    }
                }
                return (node.copT1 + node.copT2) / 2; // Fallback
            }

            // Note: Monthly fixed costs are NOT included in variable cost calculation.
            // They're irrelevant for real-time optimization (gas vs electricity decisions)
            // since they're paid regardless of which energy source is used.
            const round2 = (v) => (typeof v === "number" && !isNaN(v) ? Math.round(v * 100) / 100 : v);

            // Calendar stores cents/MWh; convert to EUR/kWh for internal calc (cents/MWh / 100 / 1000)
            // Clamp negative spot prices to 0 (negative prices should not reduce final cost)
            const spotCentsToEurPerKwh = (c) => Math.max(0, c || 0) / 100000;

            for (const p of elecPoints) {
                const spotPerKWh = spotCentsToEurPerKwh(p.value);
                const transport = pickElecTransport(
                    p.timestamp,
                    node.elecTransportDay,
                    node.elecTransportNight,
                    node.dayStartHour,
                    node.dayEndHour,
                    node.weekdaysActive,
                    holidayEvents,
                    node.useSummertime
                );

                // Base price + transport + taxes (all EUR/kWh) - variable costs only
                let total = spotPerKWh + transport + node.elecTax1 + node.elecTax2;

                // Apply VAT (on total including all costs and taxes)
                const vatMultiplier = 1 + node.elecVat / 100;
                const finalPrice = total * vatMultiplier;

                // Interpolate COP based on ambient temperature at this timestamp
                const ambientAtTime = getAmbientAtTimestamp(p.timestamp);
                const copVal = interpCop(ambientAtTime, node.copT1, node.copV1, node.copT2, node.copV2) || 1;

                const heatPrice = finalPrice / (copVal || 1);
                // Surcharge = transport + taxes WITHOUT VAT (to match spot which is also without VAT)
                const surcharge = transport + node.elecTax1 + node.elecTax2;
                elecTransportPoints.push({ timestamp: p.timestamp, value: round2(surcharge * 100000) }); // cents/MWh
                elecHeatPoints.push({ timestamp: p.timestamp, value: round2(heatPrice * 100000) }); // cents/MWh
            }
            log(`Calculated electricity: ${elecTransportPoints.length} transport points, ${elecHeatPoints.length} heat price points`);

            // Gas spot from calendar: cents/MWh (EUR/MWh wo VAT). Gas transport/taxes: entered in EUR/m³, convert to EUR/kWh using heating value
            // Gas typically has 1 point/day; replicate across full range so diagram has no nulls
            const heatingValueKWhPerM3 = node.gasHeatingValuePerM3 > 0 ? node.gasHeatingValuePerM3 : 10.0;
            const gasTransportPerKWh = node.gasTransportPerM3 / heatingValueKWhPerM3; // EUR/m³ → EUR/kWh
            const gasTax1PerKWh = node.gasTax1PerM3 / heatingValueKWhPerM3;
            const gasTax2PerKWh = node.gasTax2PerM3 / heatingValueKWhPerM3;

            function getGasValueAt(ts) {
                let best = null;
                for (const p of gasPoints) {
                    if (p.timestamp <= ts && (!best || p.timestamp > best.timestamp)) best = p;
                }
                if (!best && gasPoints.length) best = gasPoints[0];
                return best;
            }

            // Gas-derived values: only write at gas price change points (not every 15 min)
            // This avoids bloating calendar with identical values
            for (const gasPoint of gasPoints) {
                // Calendar stores cents/MWh; convert to EUR/kWh: cents/MWh / 100000
                const spotPerKWh = spotCentsToEurPerKwh(gasPoint.value);
                // Variable costs only (no monthly fixed costs - irrelevant for optimization)
                let totalPerKWh = spotPerKWh + gasTransportPerKWh + gasTax1PerKWh + gasTax2PerKWh;
                const vatMultiplier = 1 + node.gasVat / 100;
                const finalPerKWh = totalPerKWh * vatMultiplier;
                const heatPrice = finalPerKWh / boilerEff;
                // Surcharge = transport + taxes WITHOUT VAT (to match spot which is also without VAT)
                const surchargePerKWh = gasTransportPerKWh + gasTax1PerKWh + gasTax2PerKWh;

                gasTransportPoints.push({ timestamp: gasPoint.timestamp, value: round2(surchargePerKWh * 100000) }); // cents/MWh
                gasHeatPoints.push({ timestamp: gasPoint.timestamp, value: round2(heatPrice * 100000) }); // cents/MWh
            }

            if (gasPoints.length > 0) {
                const gp = gasPoints[0];
                const spotPerKWh = spotCentsToEurPerKwh(gp.value);
                const totalPerKWh = spotPerKWh + gasTransportPerKWh + gasTax1PerKWh + gasTax2PerKWh;
                const vatMultiplier = 1 + node.gasVat / 100;
                const finalPerKWh = totalPerKWh * vatMultiplier;
                const heatPrice = finalPerKWh / boilerEff;
                log(
                    `Gas calculated: ${gasPoints.length} price point(s) → ${gasTransportPoints.length} derived values | spot=${(gp.value / 100).toFixed(1)} heat=${(heatPrice * 1000).toFixed(1)} EUR/MWh`
                );
            } else {
                log(`Gas: no price points found`);
            }

            // Delete old calculated series then write new (send messages to sql-calendar nodes)
            // Note: Do NOT delete/rewrite input spot prices - they are owned by fetcher nodes
            // Electricity: delete full window (15-min granularity)
            deleteRange(node.elecTransportTitle, startTs, endTs, send);
            deleteRange(node.elecHeatTitle, startTs, endTs, send);

            // Gas: delete specific timestamps only (step values - avoid accumulating old entries)
            // Delete 1 second around each gas point timestamp
            for (const gp of gasTransportPoints) {
                deleteRange(node.gasTransportTitle, gp.timestamp, gp.timestamp + 1, send);
            }
            for (const gp of gasHeatPoints) {
                deleteRange(node.gasHeatTitle, gp.timestamp, gp.timestamp + 1, send);
            }

            // Wait for deletes to complete before writing new data
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Write electricity series (15-min granularity)
            await writeSeries(node.elecTransportTitle, elecTransportPoints, intervalSeconds, send);
            await writeSeries(node.elecHeatTitle, elecHeatPoints, intervalSeconds, send);

            // Write gas series (step values at source timestamps)
            await writeSeries(node.gasTransportTitle, gasTransportPoints, 0, send); // 0 = individual points
            await writeSeries(node.gasHeatTitle, gasHeatPoints, 0, send);

            const msgOut = {
                topic: "price-handler/status",
                _fromPriceHandler: true,
                payload: {
                    success: true,
                    elecCount: elecPoints.length,
                    gasCount: gasPoints.length,
                    intervalSeconds,
                    window: { startTs, endTs }
                }
            };
            node.status({ fill: "green", shape: "dot", text: "ok" });
            send(msgOut);
            log(`Completed | elec=${elecPoints.length} gas=${gasPoints.length} interval=${intervalSeconds}s`);
        }

        node.on("input", async (msg, send, done) => {
            // Prevent processing our own output messages (avoid loops)
            if (msg.topic === node.calendarTopic || msg._fromPriceHandler) {
                done();
                return;
            }

            const maxRetries = node.retryCount;
            const retryDelayMs = node.retryDelayMinutes * 60 * 1000;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    await runOnce(send);
                    done();
                    return;
                } catch (e) {
                    const isLastAttempt = attempt === maxRetries;
                    if (isLastAttempt) {
                        node.status({ fill: "red", shape: "ring", text: "failed after retries" });
                        err(`Failed after ${maxRetries + 1} attempts: ${e.message}`);
                        done(e);
                    } else {
                        node.status({ fill: "yellow", shape: "ring", text: `retry ${attempt + 1}/${maxRetries} in ${node.retryDelayMinutes}m` });
                        warn(`Attempt ${attempt + 1} failed: ${e.message}. Retrying in ${node.retryDelayMinutes} minutes...`);
                        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                    }
                }
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-price-handler", PriceHandlerNode);
};
