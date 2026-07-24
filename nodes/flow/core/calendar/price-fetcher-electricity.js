/**
 * price-fetcher-electricity.js
 *
 * Fetches electricity spot prices from external API and writes them to
 * sql-calendar node. Supports various price API formats including Elering.
 */

const https = require("https");
const http = require("http");

const NODE_VERSION = "0.1.2";

module.exports = function (RED) {
    function PriceFetcherElectricityNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.priceUrl = config.priceUrl || "";
        node.startParam = config.startParam || "start";
        node.endParam = config.endParam || "end";
        node.timeFormat = config.timeFormat || "offset"; // "offset" (ISO with timezone) or "utc" (ISO UTC)
        node.startHour = parseInt(config.startHour || 1, 10);
        node.startDaysOffset = parseInt(config.startDaysOffset || 0, 10);
        node.endHour = parseInt(config.endHour || 1, 10);
        node.endDaysOffset = parseInt(config.endDaysOffset || 3, 10);
        node.calendarTitle = config.calendarTitle || "electricity.spot";
        node.calendarTopic = config.calendarTopic || "calendar/prices";
        node.enableLogging = config.enableLogging !== false;
        node.debugTopics = (config.debugTopics || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        node.retryCount = parseInt(config.retryCount, 10) || 3;
        node.retryDelayMinutes = parseInt(config.retryDelayMinutes, 10) || 30;

        if (node.enableLogging) {
            node.log(`[price-fetcher-electricity v${NODE_VERSION}] Initialized | URL: ${node.priceUrl || "not set"} | Title: ${node.calendarTitle}`);
        }

        node.status({ fill: "grey", shape: "ring", text: "idle" });

        const log = (msg, topic) => {
            if (!node.enableLogging) return;
            if (node.debugTopics.length === 0 || (topic && node.debugTopics.some((p) => topic.startsWith(p)))) {
                node.log(`[price-fetcher-electricity v${NODE_VERSION}] ${msg}`);
            }
        };

        const warn = (msg) => node.warn(`[price-fetcher-electricity v${NODE_VERSION}] ${msg}`);
        const debug = (msg) => node.debug(`[price-fetcher-electricity] ${msg}`);
        const err = (msg) => node.error(`[price-fetcher-electricity] ${msg}`);

        function makeRequest(url, timeoutMs = 15000) {
            return new Promise((resolve, reject) => {
                const lib = url.startsWith("https") ? https : http;
                const req = lib.get(
                    url,
                    {
                        timeout: timeoutMs,
                        headers: {
                            "User-Agent": "Node-RED/uniflex",
                            Accept: "application/json"
                        }
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (chunk) => (data += chunk));
                        res.on("end", () => {
                            debug(`HTTP ${res.statusCode} response (${data.length} bytes)`);
                            if (res.statusCode < 200 || res.statusCode >= 300) {
                                return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                            }
                            if (!data || data.trim() === "") {
                                return reject(new Error("Empty response from API"));
                            }
                            try {
                                const parsed = JSON.parse(data);
                                resolve(parsed);
                            } catch (e) {
                                debug(`Raw response: ${data.substring(0, 500)}`);
                                reject(new Error(`Invalid JSON: ${e.message}`));
                            }
                        });
                    }
                );
                req.on("timeout", () => {
                    req.destroy(new Error("Request timeout"));
                });
                req.on("error", reject);
            });
        }

        function normalizeSeries(resp) {
            // Accept shapes:
            // 1) { data: [{timestamp, value}, ...] }
            // 2) { data: { ee: [{timestamp, price}, ...] } } - Elering electricity
            // 3) [{timestamp, value}, ...]
            // 4) { start, intervalSeconds, values: [] }
            let points = [];

            debug(`Response type: ${typeof resp}, isArray: ${Array.isArray(resp)}, keys: ${resp ? Object.keys(resp).join(",") : "null"}`);

            if (Array.isArray(resp)) {
                points = resp.map((p) => {
                    const raw = p.price !== undefined ? p.price : p.value;
                    const centsMwh = raw > 1000 ? raw : raw * 100; // EUR/MWh → cents/MWh
                    return { timestamp: p.timestamp || p.startTime, value: centsMwh };
                });
            } else if (resp && resp.data) {
                // Check for Elering nested format: { data: { ee: [...] } }
                if (resp.data.ee && Array.isArray(resp.data.ee)) {
                    debug(`Elering format detected (data.ee), ${resp.data.ee.length} points`);
                    points = resp.data.ee.map((p) => {
                        const raw = p.price !== undefined ? p.price : p.value;
                        const centsMwh = raw > 1000 ? raw : raw * 100; // EUR/MWh → cents/MWh
                        return { timestamp: p.timestamp, value: centsMwh };
                    });
                } else if (Array.isArray(resp.data)) {
                    points = resp.data;
                } else {
                    debug(`data object keys: ${Object.keys(resp.data).join(",")}`);
                    // Try to find any array in data
                    for (const key of Object.keys(resp.data)) {
                        if (Array.isArray(resp.data[key])) {
                            debug(`Found array in data.${key}, ${resp.data[key].length} points`);
                            points = resp.data[key].map((p) => {
                                const raw = p.price !== undefined ? p.price : p.value;
                                const centsMwh = raw > 1000 ? raw : raw * 100; // EUR/MWh → cents/MWh
                                return { timestamp: p.timestamp, value: centsMwh };
                            });
                            break;
                        }
                    }
                }
            } else if (resp && Array.isArray(resp.values) && resp.start !== undefined && resp.intervalSeconds) {
                points = resp.values.map((v, idx) => ({
                    timestamp: resp.start + idx * resp.intervalSeconds,
                    value: v > 1000 ? v : v * 100 // EUR/MWh → cents/MWh
                }));
            }

            if (points.length === 0) {
                debug(`Unrecognized response: ${JSON.stringify(resp).substring(0, 500)}`);
                throw new Error("Unknown price response format or empty data");
            }

            points = points
                .filter((p) => p.timestamp !== undefined && p.value !== undefined)
                .map((p) => ({
                    timestamp: p.timestamp > 1e12 ? Math.floor(p.timestamp / 1000) : Math.floor(p.timestamp),
                    value: Number(p.value)
                }))
                .filter((p) => Number.isFinite(p.value));

            points.sort((a, b) => a.timestamp - b.timestamp);

            if (points.length < 2) {
                return { points, intervalSeconds: 900 };
            }
            const diffs = [];
            for (let i = 1; i < points.length; i++) {
                diffs.push(points[i].timestamp - points[i - 1].timestamp);
            }
            const intervalSeconds = Math.min(...diffs.filter((d) => d > 0)) || 900;
            return { points, intervalSeconds };
        }

        function formatISOWithOffset(timestamp) {
            const d = new Date(timestamp * 1000);
            const offset = -d.getTimezoneOffset();
            const offsetHours = Math.floor(Math.abs(offset) / 60);
            const offsetMinutes = Math.abs(offset) % 60;
            const offsetSign = offset >= 0 ? "+" : "-";
            const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            const hours = String(d.getHours()).padStart(2, "0");
            const minutes = String(d.getMinutes()).padStart(2, "0");
            const seconds = String(d.getSeconds()).padStart(2, "0");
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetStr}`;
        }

        function formatISOUTC(timestamp) {
            const d = new Date(timestamp * 1000);
            return d.toISOString();
        }

        function inWindow(ts, startTs, endTs) {
            return ts >= startTs && ts < endTs;
        }

        async function runOnce(send, msg) {
            if (!node.priceUrl) {
                throw new Error("Price URL not configured");
            }

            let startTs, endTs;
            if (msg && msg.payload && msg.payload.startTs !== undefined && msg.payload.endTs !== undefined) {
                startTs = typeof msg.payload.startTs === "number" ? msg.payload.startTs : parseInt(msg.payload.startTs, 10);
                endTs = typeof msg.payload.endTs === "number" ? msg.payload.endTs : parseInt(msg.payload.endTs, 10);
            } else {
                const now = new Date();
                const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + node.startDaysOffset, node.startHour, 0, 0, 0);
                const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + node.endDaysOffset, node.endHour, 0, 0, 0);
                startTs = Math.floor(startDate.getTime() / 1000);
                endTs = Math.floor(endDate.getTime() / 1000);
            }

            const startStr = node.timeFormat === "utc" ? formatISOUTC(startTs) : formatISOWithOffset(startTs);
            const endStr = node.timeFormat === "utc" ? formatISOUTC(endTs) : formatISOWithOffset(endTs);
            const urlObj = new URL(node.priceUrl);
            urlObj.searchParams.set(node.startParam, startStr);
            urlObj.searchParams.set(node.endParam, endStr);
            const requestUrl = urlObj.toString();

            node.status({ fill: "blue", shape: "dot", text: "fetching..." });
            warn(`Fetching prices | title=${node.calendarTitle} | url=${requestUrl} | window ${startTs}..${endTs}`);

            const resp = await makeRequest(requestUrl);

            const { points: pointsRaw, intervalSeconds } = normalizeSeries(resp);
            const points = pointsRaw.filter((p) => inWindow(p.timestamp, startTs, endTs));

            if (points.length === 0) {
                throw new Error(`No price data in window for title=${node.calendarTitle}`);
            }

            warn(`Fetched ${points.length} price points | title=${node.calendarTitle} | interval=${intervalSeconds}s`);

            // Delete ALL old data with this title (from epoch to end of fetched window)
            // This removes historical data before startTs AND data in the fetched range
            node.status({ fill: "blue", shape: "dot", text: "deleting old..." });
            send({
                topic: node.calendarTopic,
                mode: "delete",
                title: node.calendarTitle,
                start: 0,
                end: endTs
            });

            // Wait for delete to complete before creating
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Send create messages for each price point
            node.status({ fill: "blue", shape: "dot", text: "creating..." });
            for (const p of points) {
                send({
                    topic: node.calendarTopic,
                    mode: "create",
                    title: node.calendarTitle,
                    timestamp: p.timestamp,
                    value: p.value
                });
            }

            node.status({ fill: "green", shape: "dot", text: `${points.length} pts` });
            warn(`Completed | title=${node.calendarTitle} | ${points.length} points sent to calendar`);
            // Second output: single completion trigger for downstream nodes (e.g. price-handler)
            send([null, { topic: "fetch/ele-prices/done", payload: points.length, title: node.calendarTitle }]);
        }

        node.on("input", async (msg, send, done) => {
            const maxRetries = node.retryCount;
            const retryDelayMs = node.retryDelayMinutes * 60 * 1000;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    await runOnce(send, msg);
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

    RED.nodes.registerType("uniflex-price-fetcher-electricity", PriceFetcherElectricityNode);
};
