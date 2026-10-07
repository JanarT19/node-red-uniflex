module.exports = function (RED) {
    "use strict";
    const https = require("https");

    const NODE_VERSION = "0.1.0";

    function OpenWeatherSolarFetcherNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.lat = config.lat;
        node.lon = config.lon;
        node.appid = config.appid;
        node.solarSeriesTitle = config.solarSeriesTitle || "solar_irradiance";
        node.calendarTopic = config.calendarTopic || "calendar/solar";
        node.enableLogging = config.enableLogging !== false;
        node.retryCount = parseInt(config.retryCount, 10) || 2;
        node.retryDelayMinutes = parseInt(config.retryDelayMinutes, 10) || 10;

        if (node.enableLogging) {
            node.log(`[openweather-solar v${NODE_VERSION}] Initialized | Lat: ${node.lat} | Lon: ${node.lon}`);
        }

        node.status({ fill: "grey", shape: "ring", text: "idle" });

        const log = (msg) => {
            if (node.enableLogging) {
                node.log(`[openweather-solar v${NODE_VERSION}] ${msg}`);
            }
        };

        const warn = (msg) => node.warn(`[openweather-solar v${NODE_VERSION}] ${msg}`);
        const err = (msg) => node.error(`[openweather-solar] ${msg}`);

        function makeRequest(url, timeoutMs = 15000) {
            return new Promise((resolve, reject) => {
                const req = https.get(url, {
                    timeout: timeoutMs,
                    headers: {
                        "User-Agent": "Node-RED/uniflex",
                        "Accept": "application/json"
                    }
                }, (res) => {
                    let data = "";
                    res.on("data", chunk => data += chunk);
                    res.on("end", () => {
                        if (res.statusCode === 200) {
                            try {
                                const parsed = JSON.parse(data);
                                resolve(parsed);
                            } catch (e) {
                                reject(new Error(`Invalid JSON: ${e.message}`));
                            }
                        } else if (res.statusCode === 401) {
                            reject(new Error(`HTTP 401 Unauthorized - Solar API access not enabled for this API key. Contact OpenWeather support.`));
                        } else if (res.statusCode === 404) {
                            reject(new Error(`HTTP 404 Not Found - Solar API endpoint not available. Check your subscription.`));
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                        }
                    });
                });
                req.on("error", (e) => reject(new Error(`Request error: ${e.message}`)));
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("Request timeout"));
                });
            });
        }

        async function runOnce(send) {
            if (!node.lat || !node.lon || !node.appid) {
                throw new Error("Latitude, longitude, and API key must be configured");
            }

            // OpenWeather Solar Energy API: fetch tomorrow's 24h forecast
            // API returns midnight-to-midnight for the requested date
            // Fetching tomorrow gives us a full day of future forecast
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateStr = tomorrow.toISOString().split('T')[0];
            const requestUrl = `https://api.openweathermap.org/energy/2.0/solar/interval_data?lat=${node.lat}&lon=${node.lon}&date=${dateStr}&interval=1h&appid=${node.appid}`;

            node.status({ fill: "blue", shape: "dot", text: "fetching..." });
            log(`Fetching solar forecast | date=${dateStr} (tomorrow)`);

            const resp = await makeRequest(requestUrl);

            if (!resp) {
                throw new Error("Empty API response");
            }

            if (!resp.intervals || !Array.isArray(resp.intervals)) {
                throw new Error(`Invalid response format. Keys found: ${Object.keys(resp).join(', ')}`);
            }

            const intervals = resp.intervals;
            log(`Received ${intervals.length} hourly solar intervals`);

            // Extract GHI (Global Horizontal Irradiance) in W/m²
            // Convert to kW/m² to match MPC expectations
            // API provides: intervals[].avg_irradiance.cloudy_sky.ghi
            const allPoints = [];
            const baseDate = new Date(resp.date + 'T00:00:00' + resp.tz);
            
            for (let i = 0; i < intervals.length; i++) {
                const item = intervals[i];
                
                // Calculate timestamp from base date + hour offset
                const ts = Math.floor(baseDate.getTime() / 1000) + (i * 3600);
                
                // Get GHI from cloudy_sky forecast (realistic forecast)
                const ghi = item.avg_irradiance?.cloudy_sky?.ghi;
                
                if (ghi !== undefined && ghi !== null) {
                    allPoints.push([ts, Number((ghi / 1000).toFixed(4))]); // Convert W/m² to kW/m²
                }
            }

            if (allPoints.length === 0) {
                throw new Error("No solar GHI data extracted from API response");
            }

            log(`Extracted ${allPoints.length} solar GHI points (converted to kW/m²)`);

            // Delete old solar data (start from epoch to forecast horizon)
            const lastTs = allPoints[allPoints.length - 1][0];
            node.status({ fill: "blue", shape: "dot", text: "deleting old..." });
            send({
                topic: node.calendarTopic,
                mode: "delete",
                title: node.solarSeriesTitle,
                start: 0,
                end: lastTs + 86400  // Include next 24h for safety
            });

            // Wait for delete to complete
            await new Promise(resolve => setTimeout(resolve, 500));

            // Send create messages for each point
            node.status({ fill: "blue", shape: "dot", text: "creating..." });
            for (const [ts, value] of allPoints) {
                send({
                    topic: node.calendarTopic,
                    mode: "create",
                    title: node.solarSeriesTitle,
                    timestamp: ts,
                    value: value
                });
            }

            const firstPoint = allPoints[0];
            const lastPoint = allPoints[allPoints.length - 1];
            const durationHours = Math.round((lastPoint[0] - firstPoint[0]) / 3600);
            
            node.status({ fill: "green", shape: "dot", text: `${allPoints.length} pts (${durationHours}h)` });
            warn(`Completed | ${allPoints.length} solar GHI points sent to calendar (${durationHours}h forecast)`);
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
                        node.status({ fill: "red", shape: "ring", text: "failed" });
                        err(`Failed after ${maxRetries + 1} attempts: ${e.message}`);
                        done(e);
                    } else {
                        node.status({ fill: "yellow", shape: "ring", text: `retry ${attempt + 1}/${maxRetries}` });
                        warn(`Attempt ${attempt + 1} failed: ${e.message}. Retrying in ${node.retryDelayMinutes} minutes...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                    }
                }
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-openweather-solar-fetcher", OpenWeatherSolarFetcherNode);
};
