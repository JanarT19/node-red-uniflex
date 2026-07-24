module.exports = function (RED) {
    "use strict";
    const https = require("https");
    const http = require("http");

    const NODE_VERSION = "0.1.0";

    function OpenWeatherFetcherNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.lat = config.lat;
        node.lon = config.lon;
        node.appid = config.appid;
        node.units = config.units || "metric";
        node.weatherUrl = config.weatherUrl || "";
        node.titles = (config.titles || "main_temp,clouds_all,wind_speed")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        node.calendarTopic = config.calendarTopic || "calendar/weather";
        node.enableLogging = config.enableLogging !== false;
        node.debugTopics = (config.debugTopics || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        node.retryCount = parseInt(config.retryCount, 10) || 3;
        node.retryDelayMinutes = parseInt(config.retryDelayMinutes, 10) || 30;

        if (node.enableLogging) {
            node.log(`[openweather-fetcher v${NODE_VERSION}] Initialized | Lat: ${node.lat} | Lon: ${node.lon}`);
        }

        node.status({ fill: "grey", shape: "ring", text: "idle" });

        const log = (msg, topic) => {
            if (!node.enableLogging) return;
            if (node.debugTopics.length === 0 || (topic && node.debugTopics.some((p) => topic.startsWith(p)))) {
                node.log(`[openweather-fetcher v${NODE_VERSION}] ${msg}`);
            }
        };

        const warn = (msg) => node.warn(`[openweather-fetcher v${NODE_VERSION}] ${msg}`);
        const debug = (msg) => node.debug(`[openweather-fetcher] ${msg}`);
        const err = (msg) => node.error(`[openweather-fetcher] ${msg}`);

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
                            if (res.statusCode === 200) {
                                try {
                                    const parsed = JSON.parse(data);
                                    resolve(parsed);
                                } catch (e) {
                                    reject(new Error(`Invalid JSON: ${e.message}`));
                                }
                            } else {
                                reject(new Error(`HTTP ${res.statusCode}`));
                            }
                        });
                    }
                );
                req.on("error", (e) => reject(new Error(`Request error: ${e.message}`)));
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("Request timeout"));
                });
            });
        }

        // Extract nested value from object using dot notation (e.g., "main.temp")
        function extractValue(obj, path) {
            let cur = obj;
            for (const part of path.split(".")) {
                if (cur && typeof cur === "object") {
                    cur = cur[part];
                } else {
                    return undefined;
                }
            }
            return cur;
        }

        // Convert title format: main.temp -> main_temp
        function titleToKey(title) {
            return title.replace(/\./g, "_");
        }

        // Linear interpolation to hourly intervals (3h -> 1h step)
        function interpolateToHourly(points) {
            if (points.length < 2) {
                return points;
            }

            // Sort by timestamp
            const sorted = points.slice().sort((a, b) => a[0] - b[0]);
            const interpolated = [];

            for (let i = 0; i < sorted.length - 1; i++) {
                const [ts1, val1] = sorted[i];
                const [ts2, val2] = sorted[i + 1];

                // Add original point
                interpolated.push([ts1, val1]);

                // Calculate interval
                const interval = ts2 - ts1;
                const hourlyStep = 3600;

                // Only interpolate if interval > 1 hour
                if (interval > hourlyStep) {
                    const steps = Math.floor(interval / hourlyStep);

                    // Add intermediate hourly points
                    for (let step = 1; step < steps; step++) {
                        const ts = ts1 + step * hourlyStep;
                        const ratio = (ts - ts1) / interval;
                        const val = val1 + ratio * (val2 - val1);
                        interpolated.push([ts, Math.round(val * 10) / 10]); // Round to 1 decimal
                    }
                }
            }

            // Add last point
            interpolated.push(sorted[sorted.length - 1]);

            return interpolated;
        }

        async function runOnce(send) {
            let requestUrl;
            if (node.weatherUrl) {
                requestUrl = node.weatherUrl;
            } else if (node.lat && node.lon && node.appid) {
                requestUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${node.lat}&lon=${node.lon}&appid=${node.appid}&units=${node.units}`;
            } else {
                throw new Error("Weather URL or (lat, lon, appid) must be configured");
            }

            node.status({ fill: "blue", shape: "dot", text: "fetching..." });
            warn(`Fetching weather | url=${requestUrl}`);

            const resp = await makeRequest(requestUrl);

            if (!resp || !resp.list || !Array.isArray(resp.list)) {
                throw new Error("Invalid OpenWeather response format");
            }

            const lst = resp.list;
            debug(`Received ${lst.length} weather data points`);

            // Build series: { title: [(ts, value), ...] }
            const series = {};
            for (const title of node.titles) {
                series[titleToKey(title)] = [];
            }

            for (const item of lst) {
                const ts = parseInt(item.dt, 10);
                if (!ts) continue;

                for (const title of node.titles) {
                    try {
                        const value = extractValue(item, title);
                        if (value !== undefined && value !== null) {
                            series[titleToKey(title)].push([ts, Number(value)]);
                        }
                    } catch (e) {
                        // Skip if extraction fails
                    }
                }
            }

            // Filter out empty series and apply hourly interpolation
            const nonEmptySeries = {};
            for (const [title, points] of Object.entries(series)) {
                if (points.length > 0) {
                    nonEmptySeries[title] = interpolateToHourly(points);
                }
            }

            if (Object.keys(nonEmptySeries).length === 0) {
                throw new Error("No weather data extracted");
            }

            const totalPoints = Object.values(nonEmptySeries).reduce((sum, pts) => sum + pts.length, 0);
            const rawPoints = Object.values(series).reduce((sum, pts) => sum + pts.length, 0);
            warn(`Extracted ${Object.keys(nonEmptySeries).length} series | raw: ${rawPoints} points | interpolated: ${totalPoints} points`);

            // Delete old weather data (all existing data for these titles)
            node.status({ fill: "blue", shape: "dot", text: "deleting old..." });
            for (const title of Object.keys(nonEmptySeries)) {
                send({
                    topic: node.calendarTopic,
                    mode: "delete",
                    title: title,
                    start: 0,
                    end: 2147483647
                });
            }

            // Wait for delete to complete
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Send create messages for each series
            node.status({ fill: "blue", shape: "dot", text: "creating..." });
            for (const [title, points] of Object.entries(nonEmptySeries)) {
                for (const [ts, value] of points) {
                    send({
                        topic: node.calendarTopic,
                        mode: "create",
                        title: title,
                        timestamp: ts,
                        value: value
                    });
                }
            }

            node.status({ fill: "green", shape: "dot", text: `${totalPoints} pts` });
            warn(`Completed | ${Object.keys(nonEmptySeries).length} series | ${totalPoints} points sent to calendar`);
        }

        node.on("input", async (msg, send, done) => {
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

    RED.nodes.registerType("uniflex-openweather-fetcher", OpenWeatherFetcherNode);
};
