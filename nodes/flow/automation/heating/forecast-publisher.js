const ts = require("../../core/lib/timestamp.js");
// forecast-publisher.js
// Node-RED node: forecast-publisher
// Purpose: Query weather forecast from sql-calendar on heating tick, compute lookahead values,
//          publish to iolayer topics for consumption by floor-loops and other nodes.
// Replaces Python-based ForecaTemp/ForecaWind/ForecaClouds publisher.

const http = require("http");

module.exports = function (RED) {
    function ForecastPublisherNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "forecast-publisher";

        // Calendar API
        node.calendarHost = config.calendarHost || "localhost";
        node.calendarPort = Number(config.calendarPort ?? 80);

        // Calendar series titles
        node.toutTitle = config.toutTitle || "main.temp";
        node.windTitle = config.windTitle || "wind.speed";
        node.cloudsTitle = config.cloudsTitle || "clouds.all";
        node.solarGainTitle = config.solarGainTitle || "solar_irradiance";

        // Output topic prefixes (will append .1, .2, .3, .4 for 3h, 6h, 12h, 24h)
        node.toutTopicPrefix = config.toutTopicPrefix || "FCTW";
        node.windTopicPrefix = config.windTopicPrefix || "FCWW";
        node.cloudsTopicPrefix = config.cloudsTopicPrefix || "FCCW";
        node.solarTopicPrefix = config.solarTopicPrefix || "FSRW";

        // Tick topic to listen for
        node.tickTopic = config.tickTopic || "heating/tick";

        // Lookahead horizons: hours and iolayer member numbers
        // Member 1=3h, 2=6h, 3=12h, 4=24h
        const HORIZONS = [
            { hours: 3, member: 1 },
            { hours: 6, member: 2 },
            { hours: 12, member: 3 },
            { hours: 24, member: 4 }
        ];

        // ---- STATE
        let cachedData = null; // { temp:{}, wind:{}, clouds:{}, solar:{}, ts: Date }
        let fetchInProgress = false; // Prevent concurrent fetches

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        // ---- HTTP helper for calendar API
        function httpGet(path) {
            return new Promise((resolve, reject) => {
                // Overall timeout for the entire request
                const overallTimeout = setTimeout(() => {
                    req.destroy();
                    reject(new Error("Overall request timeout (10s)"));
                }, 10000);

                const options = {
                    hostname: node.calendarHost,
                    port: node.calendarPort,
                    path,
                    method: "GET",
                    timeout: 5000
                };
                const req = http.request(options, (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        clearTimeout(overallTimeout);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(new Error(`JSON parse error: ${e.message}`));
                            }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}`));
                        }
                    });
                });
                req.on("error", (err) => {
                    clearTimeout(overallTimeout);
                    reject(err);
                });
                req.on("timeout", () => {
                    clearTimeout(overallTimeout);
                    req.destroy();
                    reject(new Error("Connection timeout"));
                });
                req.end();
            });
        }

        // Log to debug sidebar (like other nodes)
        function log(msg) {
            node.log(`[forecast-publisher:${node.name}] ${msg}`);
        }

        // Fetch value at specific time from calendar series
        // Calendar API: GET /calendar?title=xxx&start=xxx&end=xxx
        // Returns array of {timestamp, value} entries - we find the nearest one
        async function fetchNearestValue(seriesTitle, targetTimestamp) {
            // Convert ISO string to unix seconds
            const targetSec = Math.floor(new Date(targetTimestamp).getTime() / 1000);
            // Query a window around the target (±2 hours to find closest value)
            const startSec = targetSec - 7200;
            const endSec = targetSec + 7200;

            const path = `/calendar?title=${encodeURIComponent(seriesTitle)}&start=${startSec}&end=${endSec}`;
            try {
                const result = await httpGet(path);

                // Result is a plain JSON array: [{title, timestamp, value, mid}, ...]
                const data = Array.isArray(result) ? result : result?.data || [];
                if (data.length === 0) {
                    log(`No data for ${seriesTitle} near ${targetTimestamp}`);
                    return null;
                }

                // Normalize timestamps (API may return seconds or milliseconds)
                const norm = (ts) => (ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts));

                let closest = data[0];
                let minDiff = Math.abs(norm(closest.timestamp || 0) - targetSec);

                for (const entry of data) {
                    const diff = Math.abs(norm(entry.timestamp || 0) - targetSec);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closest = entry;
                    }
                }

                return closest?.value != null ? parseFloat(closest.value) : null;
            } catch (e) {
                log(`Fetch failed: ${seriesTitle} @ ${targetTimestamp} - ${e.message}`);
                return null;
            }
        }

        // Fetch all horizons for a series
        async function fetchSeriesHorizons(seriesTitle) {
            const now = Date.now();
            const values = {};

            const promises = HORIZONS.map(async (h) => {
                const ts = new Date(now + h.hours * 3600000).toISOString();
                const val = await fetchNearestValue(seriesTitle, ts);
                values[h.member] = val; // keyed by member number (1, 2, 3, 4)
            });

            await Promise.all(promises);
            return values;
        }

        // Fetch all weather data
        async function fetchAllForecasts() {
            log(`Fetching from ${node.calendarHost}:${node.calendarPort} series: ${node.toutTitle}, ${node.windTitle}, ${node.cloudsTitle}, ${node.solarGainTitle}`);
            setStatus(`Fetching... (${ts.formatStatus()})`, "yellow");

            const [temp, wind, clouds, solar] = await Promise.all([
                fetchSeriesHorizons(node.toutTitle),
                fetchSeriesHorizons(node.windTitle),
                fetchSeriesHorizons(node.cloudsTitle),
                fetchSeriesHorizons(node.solarGainTitle)
            ]);

            // Log what we got
            const tempVals = HORIZONS.map((h) => temp[h.member]?.toFixed(1) ?? "null").join(",");
            const windVals = HORIZONS.map((h) => wind[h.member]?.toFixed(1) ?? "null").join(",");
            const solarVals = HORIZONS.map((h) => solar[h.member]?.toFixed(2) ?? "null").join(",");
            log(`Fetched: T=[${tempVals}] W=[${windVals}] S=[${solarVals}]`);

            return {
                temp,
                wind,
                clouds,
                solar,
                ts: new Date()
            };
        }

        // Publish cached data to output
        function publishData() {
            if (!cachedData) return;

            const msgs = [];

            // Publish temperature horizons (FCTW.1, .2, .3, .4)
            for (const h of HORIZONS) {
                if (cachedData.temp[h.member] != null) {
                    msgs.push({
                        topic: `${node.toutTopicPrefix}.${h.member}`,
                        payload: cachedData.temp[h.member]
                    });
                }
            }

            // Publish wind horizons (FCWW.1, .2, .3, .4)
            for (const h of HORIZONS) {
                if (cachedData.wind[h.member] != null) {
                    msgs.push({
                        topic: `${node.windTopicPrefix}.${h.member}`,
                        payload: cachedData.wind[h.member]
                    });
                }
            }

            // Publish clouds horizons (FCCW.1, .2, .3, .4)
            for (const h of HORIZONS) {
                if (cachedData.clouds[h.member] != null) {
                    msgs.push({
                        topic: `${node.cloudsTopicPrefix}.${h.member}`,
                        payload: cachedData.clouds[h.member]
                    });
                }
            }

            // Publish solar gain horizons (FSRW.1, .2, .3, .4)
            for (const h of HORIZONS) {
                if (cachedData.solar[h.member] != null) {
                    msgs.push({
                        topic: `${node.solarTopicPrefix}.${h.member}`,
                        payload: cachedData.solar[h.member]
                    });
                }
            }

            // Send all messages
            for (const msg of msgs) {
                node.send(msg);
            }

            const tempStr = HORIZONS.map((h) => `${h.hours}h:${cachedData.temp[h.member]?.toFixed(1) ?? "?"}`).join(" ");
            node.debug(`[forecast-publisher] Published ${msgs.length} values: T=[${tempStr}]`);
        }

        // Main fetch and publish routine
        async function fetchAndPublish(trigger) {
            // Prevent concurrent fetches
            if (fetchInProgress) {
                node.warn(`[forecast-publisher] Fetch already in progress, skipping trigger: ${trigger}`);
                return;
            }

            fetchInProgress = true;
            log(`Tick received: ${trigger || "unknown"}`);

            try {
                cachedData = await fetchAllForecasts();
                publishData();

                const t6 = cachedData.temp[2]; // member 2 = 6h
                const w6 = cachedData.wind[2];
                const pubCount =
                    Object.values(cachedData.temp).filter((v) => v != null).length +
                    Object.values(cachedData.wind).filter((v) => v != null).length +
                    Object.values(cachedData.clouds).filter((v) => v != null).length +
                    Object.values(cachedData.solar).filter((v) => v != null).length;
                const s6 = cachedData.solar[2];
                log(`Published ${pubCount} values: T6h=${t6?.toFixed(1) ?? "?"}°C W6h=${w6?.toFixed(1) ?? "?"}m/s S6h=${s6?.toFixed(2) ?? "?"}kW`);
                setStatus(`T6h=${t6?.toFixed(1) ?? "?"}°C W=${w6?.toFixed(1) ?? "?"}m/s S=${s6?.toFixed(2) ?? "?"}kW (${ts.formatStatus()})`, "green");
            } catch (e) {
                node.error(`[forecast-publisher] Uncaught error: ${e.message}`, e);
                log(`ERROR: ${e.message}`);
                setStatus(`Error: ${e.message} (${ts.formatStatus()})`, "red");
            } finally {
                fetchInProgress = false;
            }
        }

        // ---- INPUT HANDLER
        node.on("input", async function (msg) {
            try {
                const topic = msg.topic || "";

                // ONLY respond to prices/tick (every minute), NOT heating/tick
                // This prevents race conditions when both ticks arrive simultaneously
                if (topic === "prices/tick") {
                    // Only fetch on ODD minutes to avoid conflict with heating tick at :00, :20, :40
                    const currentMinute = new Date().getMinutes();
                    if (currentMinute % 2 === 1) {
                        await fetchAndPublish(`tick:${topic}`);
                    } else {
                        // Skip even minutes (when heating tick fires)
                        log(`Skipping fetch on even minute ${currentMinute} to avoid conflict with heating tick`);
                    }
                }
                // Also accept manual trigger
                else if (topic === "" || topic === "trigger" || topic === "fetch") {
                    await fetchAndPublish("manual");
                } else {
                    // Ignore all other ticks (including heating/tick)
                    log(`Ignored message with topic: ${topic}`);
                }
            } catch (e) {
                node.error(`[forecast-publisher] Input handler error: ${e.message}`, e);
                setStatus(`Error: ${e.message}`, "red");
            }
        });

        // ---- STARTUP
        setStatus("Waiting for tick...", "grey");

        // Initial fetch on startup (optional - can be disabled)
        if (config.fetchOnStartup !== false) {
            setTimeout(() => {
                fetchAndPublish("startup");
            }, 5000); // Wait 5s for calendar to be ready
        }

        // ---- CLEANUP
        node.on("close", function () {});
    }

    RED.nodes.registerType("uniflex-forecast-publisher", ForecastPublisherNode);
};
