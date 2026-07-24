const http = require("http");
const ts = require("../../core/lib/timestamp.js");

module.exports = function (RED) {
    function SunHandlerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        function numOr(defaultValue, rawValue) {
            const n = Number(rawValue);
            return Number.isFinite(n) ? n : defaultValue;
        }

        node.name = config.name || "sun-handler";
        node.calendarHost = config.calendarHost || "localhost";
        node.calendarPort = numOr(80, config.calendarPort);
        node.cloudsTitle = (config.cloudsTitle || "clouds_all").trim();
        node.solarGainTitle = (config.solarGainTitle || "solar_irradiance").trim();
        node.irradianceOutTopic = (config.irradianceOutTopic || "").trim();
        node.calendarTopic = "calendar/sun-handler";
        node.forecastHours = 120;
        node.fetchOnStartup = config.fetchOnStartup !== false;
        node.latitude = numOr(58.9, config.latitude);
        node.longitude = numOr(25.6, config.longitude);
        node.cloudGamma = Math.max(0.2, numOr(1.4, config.cloudGamma));
        node.clearSkyPeakKwM2 = Math.max(0, numOr(1.0, config.clearSkyPeakKwM2));

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }

        function toRad(deg) {
            return (deg * Math.PI) / 180;
        }

        function normDeg(deg) {
            let v = deg % 360;
            if (v < 0) v += 360;
            return v;
        }

        function getSunPosition(tsMs, latDeg, lonDeg) {
            const d = new Date(tsMs);
            const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
            const diffMs = d - start;
            const dayOfYear = Math.floor(diffMs / 86400000);
            const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;

            const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hour - 12) / 24);
            const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
            const decl =
                0.006918 -
                0.399912 * Math.cos(gamma) +
                0.070257 * Math.sin(gamma) -
                0.006758 * Math.cos(2 * gamma) +
                0.000907 * Math.sin(2 * gamma) -
                0.002697 * Math.cos(3 * gamma) +
                0.00148 * Math.sin(3 * gamma);

            const tzOffsetMin = -d.getTimezoneOffset();
            const timeOffset = eqTime + 4 * lonDeg - tzOffsetMin;
            const trueSolarTimeMin = (d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + timeOffset + 1440) % 1440;
            const hourAngleDeg = trueSolarTimeMin / 4 - 180;
            const hourAngle = toRad(hourAngleDeg);
            const lat = toRad(latDeg);

            const cosZenith = clamp(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle), -1, 1);
            const zenith = Math.acos(cosZenith);
            const elevationDeg = 90 - (zenith * 180) / Math.PI;

            const azimuthDeg = normDeg((Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) * 180) / Math.PI + 180);
            return { elevationDeg, azimuthDeg };
        }

        function cloudsToFactor(cloudPct) {
            const cloud01 = clamp(Number(cloudPct) / 100, 0, 1);
            return Math.pow(1 - cloud01, node.cloudGamma);
        }

        function computeIrradiance(tsSec, cloudPct) {
            const sun = getSunPosition(tsSec * 1000, node.latitude, node.longitude);
            if (sun.elevationDeg <= 0) return 0;
            return node.clearSkyPeakKwM2 * Math.sin(toRad(sun.elevationDeg)) * cloudsToFactor(cloudPct);
        }

        function httpGet(path) {
            return new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        hostname: node.calendarHost,
                        port: node.calendarPort,
                        path,
                        method: "GET",
                        timeout: 8000
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (chunk) => {
                            data += chunk;
                        });
                        res.on("end", () => {
                            if (res.statusCode < 200 || res.statusCode >= 300) {
                                reject(new Error(`HTTP ${res.statusCode}`));
                                return;
                            }
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(new Error(`JSON parse error: ${e.message}`));
                            }
                        });
                    }
                );
                req.on("error", reject);
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("Request timeout"));
                });
                req.end();
            });
        }

        async function fetchCloudSeries(startSec, endSec) {
            const path = `/calendar?title=${encodeURIComponent(node.cloudsTitle)}&start=${startSec}&end=${endSec}`;
            const rows = await httpGet(path);
            const arr = Array.isArray(rows) ? rows : rows?.data || [];
            return arr
                .map((r) => ({
                    timestamp: Number(r.timestamp),
                    value: Number(r.value)
                }))
                .filter((r) => Number.isFinite(r.timestamp) && Number.isFinite(r.value))
                .sort((a, b) => a.timestamp - b.timestamp);
        }

        function sendCalendarDelete(startSec, endSec) {
            node.send({
                topic: node.calendarTopic,
                mode: "delete",
                title: node.solarGainTitle,
                start: startSec,
                end: endSec,
                _fromSunHandler: true
            });
        }

        function sendCalendarCreates(points) {
            for (const p of points) {
                node.send({
                    topic: node.calendarTopic,
                    mode: "create",
                    title: node.solarGainTitle,
                    timestamp: p.timestamp,
                    value: p.value,
                    _fromSunHandler: true
                });
            }
        }

        async function fetchComputeWrite(reason) {
            try {
                const nowSec = Math.floor(Date.now() / 1000);
                const endSec = nowSec + Math.floor(node.forecastHours * 3600);
                const cloudRows = await fetchCloudSeries(nowSec, endSec);
                if (!cloudRows.length) {
                    setStatus("No cloud forecast rows", "yellow");
                    return;
                }
                const points = cloudRows.map((r) => {
                    const ts = r.timestamp > 1e12 ? Math.floor(r.timestamp / 1000) : Math.floor(r.timestamp);
                    return {
                        timestamp: ts,
                        value: Number(computeIrradiance(ts, r.value).toFixed(4))
                    };
                });
                // Delete ALL old entries through forecast horizon (start from epoch)
                sendCalendarDelete(0, endSec);
                await new Promise((resolve) => setTimeout(resolve, 150));
                sendCalendarCreates(points);

                // Publish current irradiance on topic
                if (node.irradianceOutTopic) {
                    const nowCloud = cloudRows[0];
                    const nowTs = nowCloud.timestamp > 1e12 ? Math.floor(nowCloud.timestamp / 1000) : Math.floor(nowCloud.timestamp);
                    const nowIrr = computeIrradiance(nowTs, nowCloud.value);
                    node.send({ topic: node.irradianceOutTopic, payload: Number(nowIrr.toFixed(4)) });
                }

                const in6hTs = nowSec + 6 * 3600;
                let near6h = points[0];
                let bestD = Infinity;
                for (const p of points) {
                    const d = Math.abs(p.timestamp - in6hTs);
                    if (d < bestD) {
                        bestD = d;
                        near6h = p;
                    }
                }
                setStatus(`irr ok (${points.length} pts, 6h=${(near6h?.value ?? 0).toFixed(3)} kW/m², ${reason})`, "green");
            } catch (e) {
                node.warn(`[sun-handler:${node.name}] ${e.message}`);
                setStatus(`Error: ${e.message}`, "red");
            }
        }

        node.on("input", async (msg) => {
            if (msg._fromSunHandler) return;
            const topic = String(msg.topic || "");
            await fetchComputeWrite(`trigger:${topic || "manual"}`);
        });

        setStatus("Waiting for trigger...", "grey");
        if (node.fetchOnStartup) {
            setTimeout(() => {
                fetchComputeWrite("startup");
            }, 5000);
        }
    }

    RED.nodes.registerType("uniflex-sun-handler", SunHandlerNode);
};
