const ts = require("../../core/lib/timestamp.js");
// forecast-cache.js
// Node-RED node: uniflex-forecast-cache
// Version: 1.3.2-date-avg
// Purpose: Fetch full forecast arrays (Tout, wind, irradiance) from sql-calendar
//          and store in GLOBAL context for consumption by mpc-room-advanced nodes across all flow tabs.
//          Also writes main_temp_avg: one mean of main_temp per local date, from today forward.
// Triggered by: cron (twice daily), manual input, or startup (with retry).
// NOT on every heating tick.

const http = require("http");
const fs = require("fs");

module.exports = function (RED) {
    function ForecastCacheNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const name = config.name || "forecast-cache";
        const calendarHost = (config.calendarHost || "localhost").trim();
        const calendarPort = Number(config.calendarPort ?? 80);

        const toutTitle = (config.toutTitle || "main_temp").trim();
        const windTitle = (config.windTitle || "wind_speed").trim();
        const irradianceTitle = (config.irradianceTitle || "solar_irradiance").trim();

        const stepSec = Math.max(60, (parseInt(config.forecastStepMin) || 60) * 60);
        // 5-day forecast. Heating looks ~96 h ahead of each planned hour (Ci/Uenv).
        const FETCH_WINDOW_SEC = 120 * 3600;
        const avgTitle = "main_temp_avg";

        function log(msg) { node.log(`[forecast-cache:${name}] ${msg}`); }


        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        // Fetch calendar series and build slot array from whatever data is available
        function fetchSeries(seriesTitle, lookbackSec) {
            return new Promise((resolve) => {
                const now = Math.floor(Date.now() / 1000);
                const startTime = now - (lookbackSec || 24 * 3600);
                const endTime = now + FETCH_WINDOW_SEC;
                const path = `/calendar?title=${encodeURIComponent(seriesTitle)}&start=${startTime}&end=${endTime}`;

                const req = http.request({
                    hostname: calendarHost,
                    port: calendarPort,
                    path,
                    method: "GET",
                    timeout: 8000
                }, (res) => {
                    let data = "";
                    res.on("data", chunk => data += chunk);
                    res.on("end", () => {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            log(`Fetch failed for ${seriesTitle}: HTTP ${res.statusCode}`);
                            return resolve([]);
                        }
                        let rows;
                        try { rows = JSON.parse(data); } catch (e) {
                            log(`JSON parse error for ${seriesTitle}: ${e.message}`);
                            return resolve([]);
                        }
                        if (!Array.isArray(rows)) return resolve([]);

                        const normalized = rows
                            .filter(p => p.timestamp !== undefined && p.value !== undefined)
                            .map(p => ({
                                ts: p.timestamp > 1e12 ? Math.floor(p.timestamp / 1000) : Math.floor(p.timestamp),
                                v: parseFloat(p.value)
                            }))
                            .filter(p => Number.isFinite(p.v))
                            .sort((a, b) => a.ts - b.ts);
                        resolve(normalized);
                    });
                });
                req.on("error", (err) => {
                    log(`Fetch error for ${seriesTitle}: ${err.message}`);
                    resolve([]);
                });
                req.on("timeout", () => { req.destroy(); resolve([]); });
                req.end();
            });
        }

        // Build a slot array from normalized data points, covering all available future data.
        // For slots before the first data point (e.g. data starts at 18:00 but base is 16:00),
        // forward-fill from the earliest available value instead of falling back to defaultValue.
        // This prevents bogus 0°C entries in the cache head when the fetcher rewrites the calendar.
        function buildSlotArray(normalized, baseSlot, defaultValue) {
            if (normalized.length === 0) return [];
            const futurePoints = normalized.filter(p => p.ts >= baseSlot);
            if (futurePoints.length === 0) return [];
            const lastTs = futurePoints[futurePoints.length - 1].ts;
            const numSlots = Math.floor((lastTs - baseSlot) / stepSec) + 1;
            const firstKnownValue = normalized[0].v; // forward-fill sentinel for pre-data slots

            const values = [];
            for (let s = 0; s < numSlots; s++) {
                const slotStart = baseSlot + s * stepSec;
                let value = null;
                for (let i = normalized.length - 1; i >= 0; i--) {
                    if (normalized[i].ts <= slotStart) {
                        value = normalized[i].v;
                        break;
                    }
                }
                // No past point found: data starts in the future for this slot.
                // Use the earliest known value rather than the default (avoids 0°C head entries).
                if (value === null) value = firstKnownValue;
                values.push(Number.isFinite(value) ? value : defaultValue);
            }
            return values;
        }

        function calendarRequest(method, path, bodyObj) {
            return new Promise((resolve) => {
                const payload = bodyObj ? JSON.stringify(bodyObj) : null;
                const headers = {};
                if (payload) {
                    headers["Content-Type"] = "application/json";
                    headers["Content-Length"] = Buffer.byteLength(payload);
                }
                const req = http.request(
                    {
                        hostname: calendarHost,
                        port: calendarPort,
                        path: path,
                        method: method,
                        timeout: 8000,
                        headers: headers
                    },
                    (res) => {
                        res.on("data", () => {});
                        res.on("end", () => resolve(res.statusCode || 0));
                    }
                );
                req.on("error", () => resolve(0));
                req.on("timeout", () => {
                    req.destroy();
                    resolve(0);
                });
                if (payload) req.write(payload);
                req.end();
            });
        }

        function localMidnight(tsSec) {
            const d = new Date(tsSec * 1000);
            d.setHours(0, 0, 0, 0);
            return Math.floor(d.getTime() / 1000);
        }

        function nextLocalMidnight(midnightTs) {
            const d = new Date(midnightTs * 1000);
            d.setDate(d.getDate() + 1);
            d.setHours(0, 0, 0, 0);
            return Math.floor(d.getTime() / 1000);
        }

        function dayLabel(midnightTs) {
            const d = new Date(midnightTs * 1000);
            const pad = (n) => String(n).padStart(2, "0");
            return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
        }

        // One mean per local date, from today through the last forecast sample.
        // Today mixes measured hours and the forecast for the rest of the date.
        // Returns the mean repeated on each cache slot, so callers can index like Tout.
        function buildDateAvg(toutRaw, baseSlot) {
            const empty = { bySlot: [], days: [] };
            if (!toutRaw.length) return empty;
            const lastTs = toutRaw[toutRaw.length - 1].ts;
            if (lastTs < baseSlot) return empty;
            const today0 = localMidnight(baseSlot);
            function held(ts) {
                let value = null;
                for (let i = toutRaw.length - 1; i >= 0; i--) {
                    if (toutRaw[i].ts <= ts) {
                        value = toutRaw[i].v;
                        break;
                    }
                }
                return value;
            }
            const days = [];
            for (let midnight = today0; midnight <= lastTs; midnight = nextLocalMidnight(midnight)) {
                const next = nextLocalMidnight(midnight);
                let sum = 0;
                let count = 0;
                for (let ts = midnight; ts < next && ts <= lastTs; ts += stepSec) {
                    if (ts < toutRaw[0].ts) continue;
                    const v = held(ts);
                    if (!Number.isFinite(v)) continue;
                    sum += v;
                    count++;
                }
                if (count === 0) continue;
                days.push({
                    ts: midnight,
                    v: Math.round((sum / count) * 10) / 10,
                    hours: count,
                    label: dayLabel(midnight)
                });
            }
            const numSlots = Math.floor((lastTs - baseSlot) / stepSec) + 1;
            const bySlot = [];
            for (let s = 0; s < numSlots; s++) {
                const midnight = localMidnight(baseSlot + s * stepSec);
                let mean = null;
                for (let i = 0; i < days.length; i++) {
                    if (days[i].ts === midnight) {
                        mean = days[i].v;
                        break;
                    }
                }
                bySlot.push(mean);
            }
            return { bySlot: bySlot, days: days };
        }

        async function writeToutAvg(toutRaw, baseSlot) {
            const built = buildDateAvg(toutRaw, baseSlot);
            if (built.days.length === 0) {
                log("main_temp_avg: no outdoor samples, skipped");
                return built.bySlot;
            }
            // One row per date. Past dates are deleted so the series does not accumulate.
            await calendarRequest(
                "DELETE",
                `/calendar?title=${encodeURIComponent(avgTitle)}&start=0&end=2147483647`
            );
            let ok = 0;
            const parts = [];
            for (const day of built.days) {
                const status = await calendarRequest("POST", "/calendar", {
                    configuration: { title: avgTitle, timestamp: day.ts, value: day.v }
                });
                if (status >= 200 && status < 300) ok++;
                parts.push(day.label + "=" + day.v + "C/" + day.hours + "h");
            }
            log(`main_temp_avg: wrote ${ok}/${built.days.length} dates (${parts.join(", ")})`);
            writeToutAvgFile(built.days);
            return built.bySlot;
        }

        // Chart page reads this file. /calendar from the browser is rejected (401).
        function writeToutAvgFile(days) {
            const body = JSON.stringify({ values: days.map(function (d) { return d.v; }) }) + "\n";
            const paths = [
                "/home/nodered/logs/tout_avg.json",
                "/root/pyapp/webui/tout_avg.json"
            ];
            for (let i = 0; i < paths.length; i++) {
                try {
                    fs.writeFileSync(paths[i], body);
                    log("main_temp_avg file " + paths[i]);
                } catch (e) {
                    log("main_temp_avg file " + paths[i] + " failed: " + e.message);
                }
            }
        }

        async function fetchAndCache(trigger) {
            log(`Triggered: ${trigger}`);
            setStatus(`Fetching... (${ts.formatStatus()})`, "yellow");

            try {
                const now = Math.floor(Date.now() / 1000);
                const baseSlot = Math.floor(now / stepSec) * stepSec;

                const [toutRaw, windRaw, irrRaw] = await Promise.all([
                    fetchSeries(toutTitle, 24 * 3600 + stepSec),
                    fetchSeries(windTitle),
                    fetchSeries(irradianceTitle)
                ]);

                const Tout = buildSlotArray(toutRaw, baseSlot, 0);
                const ToutAvg = await writeToutAvg(toutRaw, baseSlot);
                const wind = buildSlotArray(windRaw, baseSlot, 3.0);
                const irradiance = buildSlotArray(irrRaw, baseSlot, 0);

                const slots = Math.max(Tout.length, wind.length, irradiance.length);
                const horizonH = (slots * stepSec / 3600).toFixed(0);

                const cache = {
                    timestamp: Date.now(),
                    baseSlot,
                    stepSec,
                    slots,
                    Tout,
                    ToutAvg,
                    wind,
                    irradiance
                };
                node.context().global.set("forecastCache", cache);

                const tRange = Tout.length > 0
                    ? `${Math.min(...Tout).toFixed(1)}..${Math.max(...Tout).toFixed(1)}`
                    : "n/a";
                log(`Cached: Tout=${Tout.length} wind=${wind.length} irr=${irradiance.length} slots @ ${stepSec / 60}min (${horizonH}h) T=[${tRange}°C]`);
                setStatus(`${slots} slots ${horizonH}h T=[${tRange}°C] (${ts.formatStatus()})`, "green");
            } catch (e) {
                log(`ERROR: ${e.message}`);
                setStatus(`Error: ${e.message} (${ts.formatStatus()})`, "red");
            }
        }

        node.on("input", async function (msg) {
            await fetchAndCache(`input:${msg.topic || "trigger"}`);
        });

        setStatus("Waiting for trigger...", "grey");

        // Startup fetch with retry logic
        let startupTimer = null;
        let retryTimer = null;
        if (config.fetchOnStartup !== false) {
            let retryCount = 0;
            const MAX_RETRIES = 3;
            
            async function tryStartupFetch() {
                log(`Startup fetch attempt ${retryCount + 1}/${MAX_RETRIES + 1}`);
                try {
                    await fetchAndCache("startup");
                    // Success - check if cache was populated
                    const cache = node.context().global.get("forecastCache");
                    if (cache && cache.irradiance && cache.irradiance.length > 0) {
                        log(`Startup fetch successful - cache populated with ${cache.slots} slots`);
                        return; // Success, no retry needed
                    } else {
                        log(`Startup fetch returned empty cache - will retry`);
                        throw new Error("Empty cache");
                    }
                } catch (e) {
                    log(`Startup fetch failed: ${e.message}`);
                    retryCount++;
                    if (retryCount < MAX_RETRIES) {
                        const delay = retryCount * 5000; // 5s, 10s, 15s
                        log(`Retrying in ${delay/1000}s...`);
                        retryTimer = setTimeout(tryStartupFetch, delay);
                    } else {
                        log(`Startup fetch failed after ${MAX_RETRIES} retries - waiting for cron or manual trigger`);
                        setStatus(`Startup failed - waiting for cron (${ts.formatStatus()})`, "red");
                    }
                }
            }
            
            // Start first attempt after 2s (reduced from 10s)
            startupTimer = setTimeout(tryStartupFetch, 2000);
        }

        node.on("close", function () {
            if (startupTimer) clearTimeout(startupTimer);
            if (retryTimer) clearTimeout(retryTimer);
        });
    }

    RED.nodes.registerType("uniflex-forecast-cache", ForecastCacheNode);
};
