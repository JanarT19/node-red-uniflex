// cal2datastream.js
// Node-RED node: cal2datastream
// Purpose: Read values from calendar series and publish to iolayer datastream
// Generic bridge between calendar time-series and iolayer real-time datastreams

const http = require("http");
const ts = require("../lib/timestamp.js");

module.exports = function (RED) {
    const NODE_VERSION = "1.0.0";

    function Cal2DatastreamNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "cal2datastream";

        // Calendar API
        node.calendarHost = config.calendarHost || "localhost";
        node.calendarPort = Number(config.calendarPort ?? 80);

        // Output datastream
        node.outTopic = config.outTopic || "";
        node.valueMode = String(config.valueMode || "raw")
            .trim()
            .toLowerCase();
        if (node.valueMode !== "raw" && node.valueMode !== "binary") {
            node.valueMode = "raw";
        }

        // Mappings: array of {title, member, description} (editor may save as JSON string)
        let raw = config.mappings;
        if (Array.isArray(raw)) {
            node.mappings = raw;
        } else if (typeof raw === "string" && raw.trim()) {
            try {
                node.mappings = JSON.parse(raw) || [];
            } catch (e) {
                node.mappings = [];
            }
        } else {
            node.mappings = [];
        }

        // ---- STATE
        let lastValues = {};

        function log(msg) {
            node.debug(`[cal2datastream:${node.name}] ${msg}`);
        }

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        function normalizeValue(mapping, value) {
            void mapping;
            if (value === null || value === undefined) return 0;
            const n = Number(value);
            if (!Number.isFinite(n)) return 0;
            if (node.valueMode !== "binary") return n;
            return n !== 0 ? 1 : 0;
        }

        // ---- HTTP helper for calendar API
        function httpGet(path) {
            return new Promise((resolve, reject) => {
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
                req.on("error", reject);
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("Timeout"));
                });
                req.end();
            });
        }

        // Query current value for a calendar series title
        async function queryCurrentValue(title) {
            // Use the same "check=true" semantics as uniflex-sql-calendar first.
            // This avoids mismatches where range-query selection differs from check-mode value.
            try {
                const checkPath = `/calendar?title=${encodeURIComponent(title)}&check=true`;
                const checkData = await httpGet(checkPath);
                if (checkData && checkData.value !== undefined && checkData.value !== null) {
                    const v = Number(checkData.value);
                    if (Number.isFinite(v)) return v;
                }
            } catch (e) {
                log(`check=true query failed for ${title}: ${e.message}`);
            }

            const now = Math.floor(Date.now() / 1000);
            // Query range: 30 days before now to 1 hour after
            // Wide range needed for "step" values like gas prices that may be set once and valid for weeks
            const start = now - 30 * 24 * 3600; // 30 days back
            const end = now + 3600;

            const path = `/calendar?title=${encodeURIComponent(title)}&start=${start}&end=${end}`;

            try {
                const data = await httpGet(path);
                if (!data || !Array.isArray(data) || data.length === 0) {
                    return null;
                }

                // Find the most recent value that's valid now (timestamp <= now)
                // Sort by timestamp descending
                const sorted = data.filter((p) => p.timestamp <= now).sort((a, b) => b.timestamp - a.timestamp);

                if (sorted.length > 0) {
                    return parseFloat(sorted[0].value);
                }
                return null;
            } catch (e) {
                log(`Query failed for ${title}: ${e.message}`);
                return null;
            }
        }

        // Fetch all configured series and publish to iolayer
        async function fetchAndPublish(send) {
            if (!node.outTopic || node.mappings.length === 0) {
                return;
            }

            const values = {};
            const messages = [];
            const noRecord = [];

            for (const mapping of node.mappings) {
                const value = await queryCurrentValue(mapping.title);
                const member = Number(mapping.member);
                if (member <= 0) continue;

                const outValue = normalizeValue(mapping, value);
                values[member] = outValue;
                messages.push({
                    topic: `${node.outTopic}.${member}`,
                    payload: outValue
                });
                if (value === null || !Number.isFinite(value)) {
                    noRecord.push(`.${member}=${mapping.title}`);
                }
            }

            if (noRecord.length > 0) {
                node.warn(`[cal2datastream:${node.name}] No calendar record (publishing 0): ${noRecord.join(", ")}`);
            }

            // Send all messages
            for (const msg of messages) {
                send(msg);
            }

            lastValues = values;

            const sentMembers = Object.keys(values)
                .map(Number)
                .sort((a, b) => a - b)
                .map((m) => `.${m}=${values[m]}`)
                .join(" ");
            node.log(`[cal2datastream:${node.name}] Sent ${node.outTopic}: ${sentMembers}`);

            const memberCount = messages.length;
            const preview = node.mappings
                .slice(0, 2)
                .map((m) => {
                    const v = values[m.member];
                    return v !== undefined ? `${m.member}:${Number(v).toFixed(0)}` : `${m.member}:-`;
                })
                .join(" ");

            setStatus(`${memberCount}/${node.mappings.length} | ${preview} (${ts.formatStatus()})`, memberCount === node.mappings.length ? "green" : "yellow");

            log(`Published ${memberCount} values to ${node.outTopic}`);
        }

        // ---- MESSAGE HANDLER
        node.on("input", function (msg, send, done) {
            send =
                send ||
                function (m) {
                    node.send(m);
                };

            // Fetch and publish on any input trigger
            fetchAndPublish(send);

            if (done) done();
        });

        // ---- STARTUP
        node.log(`[cal2datastream:${node.name}] v${NODE_VERSION} | topic=${node.outTopic} | mode=${node.valueMode} | ${node.mappings.length} mappings`);

        if (node.mappings.length > 0) {
            const mappingDesc = node.mappings.map((m) => `.${m.member}=${m.title}`).join(" ");
            log(`Mappings: ${mappingDesc}`);
        }

        setStatus("Waiting for trigger", "grey");
    }

    RED.nodes.registerType("uniflex-cal2datastream", Cal2DatastreamNode);
};
