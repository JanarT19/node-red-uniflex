const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function AveragerGatedNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        node.inputTopics = config.inputTopics || [];
        node.outputTopic = config.outputTopic;
        node.outputMode = config.outputMode || "any-input";
        node.selectedInputTopic = (config.selectedInputTopic || "").trim();
        node.timeoutSec = parseInt(config.timeoutSec) || 300;
        node.minValues = parseInt(config.minValues) || 1;
        node.precision = parseInt(config.precision) || 2;
        node.repeatWhenGateMissing = config.repeatWhenGateMissing !== false; // Default to true
        node.missingValueBehavior = config.missingValueBehavior || "no-output"; // "no-output" | "average-remaining"
        node.enableLogging = config.enableLogging !== false; // Default to true

        // Migration: old config had per-row value+gate; new config has single gateTopic + value-only rows
        let gateTopic = (config.gateTopic || "").trim();
        const valueTopicMapping = {}; // { valueTopicPattern: true } for matching
        const valueTopicsList = []; // ordered list of configured value topic strings
        if (!gateTopic && node.inputTopics.length > 0) {
            const first = node.inputTopics[0];
            gateTopic = (first.gateManual ? first.gateManualInput || "" : first.gateSelect || "").trim();
        }
        node.inputTopics.forEach((t) => {
            const valueTopic = (t.valueManual ? t.valueManualInput : t.valueSelect) || "";
            const vt = valueTopic.trim();
            if (vt) {
                valueTopicMapping[vt] = true;
                valueTopicsList.push(vt);
            }
        });
        node.gateTopic = gateTopic;

        if (valueTopicsList.length === 0) {
            node.error("No value topics configured");
            node.status({ fill: "red", shape: "dot", text: "No value topics" });
            return;
        }
        if (!gateTopic) {
            node.error("Gate topic not configured");
            node.status({ fill: "red", shape: "dot", text: "Gate topic missing" });
            return;
        }

        // State: single gate for the node; cache per value topic (no per-value gate)
        const gateState = { value: 0, timestamp: 0 }; // 0 = closed, 1 = open
        const cache = {}; // { valueTopic: { value, timestamp, lastValidValue, lastValidTimestamp } }

        // Track previous insufficient data state to avoid log spam
        let lastInsufficientDataState = null;

        // Helper: Check if topic matches any pattern (supports wildcards)
        function matchesPattern(topic, pattern) {
            // Convert MQTT wildcards to regex
            // + matches single level, # matches multiple levels
            if (pattern.includes("+") || pattern.includes("#")) {
                const regexPattern = pattern.replace(/\+/g, "[^/]+").replace(/#/g, ".*").replace(/\//g, "\\/");
                const regex = new RegExp(`^${regexPattern}$`);
                return regex.test(topic);
            }
            // Also support ? wildcard for single character
            if (pattern.includes("?")) {
                const regexPattern = pattern.replace(/\?/g, ".").replace(/\//g, "\\/");
                const regex = new RegExp(`^${regexPattern}$`);
                return regex.test(topic);
            }
            return topic === pattern;
        }

        // Helper: Find matching topic from mapping (supports wildcards)
        function findMatchingTopic(topic, mapping) {
            for (const [pattern] of Object.entries(mapping)) {
                if (matchesPattern(topic, pattern)) {
                    return { pattern };
                }
            }
            return null;
        }

        function isGateTopic(topic) {
            return matchesPattern(topic, node.gateTopic);
        }

        // Helper: Calculate average. Single gate; value topics only (no per-value gate).
        // Returns: { avg, gateMissing, gateClosed, details, partial?: string[] }
        function calculateAverage() {
            const now = Date.now();
            const result = {
                avg: null,
                gateMissing: false,
                gateClosed: false,
                details: {
                    validCount: 0,
                    totalCount: valueTopicsList.length,
                    minRequired: node.minValues,
                    entries: []
                },
                partial: []
            };

            // Gate missing = never received or no message for > timeoutSec
            const gateAgeSec = gateState.timestamp ? (now - gateState.timestamp) / 1000 : Infinity;
            if (!gateState.timestamp || gateAgeSec > node.timeoutSec) {
                result.gateMissing = true;
                result.details.gateMissingSec = gateState.timestamp ? Math.round(gateAgeSec) : null;
                return result;
            }
            if (gateState.value === 0 && !node.repeatWhenGateMissing) {
                result.gateClosed = true;
                return result;
            }

            const validEntries = [];
            for (const valueTopic of valueTopicsList) {
                const entry = cache[valueTopic];
                const lastValidAge = entry?.lastValidTimestamp ? (now - entry.lastValidTimestamp) / 1000 : Infinity;
                let valueToUse = null;
                let reason = "";

                if (!entry) {
                    reason = "no value received";
                } else if (entry.value !== null && entry.value !== undefined) {
                    valueToUse = entry.value;
                    reason = "value";
                } else if (entry.lastValidValue !== null && entry.lastValidValue !== undefined && lastValidAge <= node.timeoutSec) {
                    valueToUse = entry.lastValidValue;
                    reason = "lastValid";
                } else if (entry.lastValidValue === null || entry.lastValidValue === undefined) {
                    reason = "no lastValidValue";
                } else {
                    reason = `stale (age=${lastValidAge.toFixed(1)}s > ${node.timeoutSec}s)`;
                }

                result.details.entries.push({
                    valueTopic,
                    value: entry?.value,
                    lastValidValue: entry?.lastValidValue,
                    lastValidAge: entry?.lastValidTimestamp ? lastValidAge.toFixed(1) : "N/A",
                    used: valueToUse !== null && valueToUse !== undefined,
                    reason
                });

                if (valueToUse !== null && valueToUse !== undefined) {
                    validEntries.push(valueToUse);
                } else {
                    result.partial.push(valueTopic);
                }
            }

            result.details.validCount = validEntries.length;

            if (node.missingValueBehavior === "no-output" && result.partial.length > 0) {
                return result;
            }
            if (node.missingValueBehavior === "average-remaining" && validEntries.length < node.minValues) {
                return result;
            }
            if (validEntries.length < node.minValues) {
                return result;
            }

            const sum = validEntries.reduce((acc, val) => acc + val, 0);
            const avg = sum / validEntries.length;
            result.avg = parseFloat(avg.toFixed(node.precision));
            return result;
        }

        // Helper: Publish average to output topic
        function publishAverage() {
            const result = calculateAverage();

            // Gate missing: no output, status reports it
            if (result.gateMissing) {
                const sec = result.details.gateMissingSec != null ? result.details.gateMissingSec : node.timeoutSec;
                const statusText = `Gate missing (no message >${sec}s)`;
                node.status({ fill: "yellow", shape: "dot", text: statusText });
                if (node.enableLogging) {
                    node.log(`[${node.name || "uniflex-averager-gated"}] ${statusText}`);
                }
                lastInsufficientDataState = true;
                return;
            }

            // Gate closed (and repeat disabled): no output
            if (result.gateClosed) {
                node.status({ fill: "yellow", shape: "dot", text: "Gate closed" });
                lastInsufficientDataState = true;
                return;
            }

            if (result.avg === null) {
                const details = result.details;
                const staleTopics = result.partial.length ? result.partial : details.entries.filter((e) => e.reason.includes("stale")).map((e) => e.valueTopic);

                let statusText;
                if (staleTopics.length > 0 && details.validCount === 0) {
                    statusText = `Timeout, no output (stale >${node.timeoutSec}s): ${staleTopics.join(", ")}`;
                } else if (staleTopics.length > 0) {
                    statusText = `Insufficient data (${details.validCount}/${details.minRequired} min); stale: ${staleTopics.join(", ")}`;
                } else {
                    statusText = `Insufficient data (${details.validCount}/${details.minRequired} min)`;
                }

                node.status({ fill: "yellow", shape: "dot", text: statusText });

                const isStateChange = lastInsufficientDataState !== true;
                const allStale = details.entries.length > 0 && details.validCount === 0;
                const shouldLog = (isStateChange || allStale) && node.enableLogging;
                if (shouldLog) {
                    let detailMsg = `[${node.name || "uniflex-averager-gated"}] ${statusText}`;
                    detailMsg += ` - Total: ${details.totalCount}, Valid: ${details.validCount}, Required: ${details.minRequired}`;
                    if (details.entries.length > 0) {
                        detailMsg += "\nEntry details:";
                        details.entries.forEach((entry) => {
                            const status = entry.used ? "✓" : "✗";
                            detailMsg += `\n  ${status} ${entry.valueTopic}: ${entry.reason}`;
                        });
                    }
                    node.log(detailMsg);
                }
                lastInsufficientDataState = true;
                return;
            }

            lastInsufficientDataState = false;

            if (!node.outputTopic || node.outputTopic.trim() === "") {
                node.warn("Output topic not configured - cannot send average");
                return;
            }

            const msg = { topic: node.outputTopic, payload: result.avg };
            if (node.enableLogging) {
                node.warn(`[${node.name || "uniflex-averager-gated"}] -> ${JSON.stringify(msg)}`);
            }
            node.send(msg);

            const details = result.details;
            if (result.partial && result.partial.length > 0) {
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: `Partial (missing: ${result.partial.join(", ")}): ${result.avg}`
                });
            } else {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: `${result.avg} (${details.validCount}/${details.totalCount} inputs)`
                });
            }
        }

        // Handle incoming messages
        node.on("input", function (msg) {
            const topic = msg.topic;
            let shouldOutput = node.outputMode === "any-input" || (node.outputMode === "selected-input" && topic === node.selectedInputTopic);

            // Single gate topic
            if (isGateTopic(topic)) {
                const gateValue = msg.payload === null || msg.payload === undefined ? null : parseFloat(msg.payload);
                const gate = gateValue === null || isNaN(gateValue) || gateValue === 0 ? 0 : 1;
                gateState.value = gate;
                gateState.timestamp = Date.now();
                if (node.enableLogging) {
                    node.log(`[${node.name || "uniflex-averager-gated"}] Gate: ${gate}`);
                }
                if (shouldOutput) publishAverage();
                return;
            }

            // Value topic
            const valueMatch = findMatchingTopic(topic, valueTopicMapping);
            if (valueMatch) {
                const valueTopic = valueMatch.pattern;
                const value = msg.payload === null || msg.payload === undefined ? null : parseFloat(msg.payload);

                if (value === null || isNaN(value)) {
                    if (cache[valueTopic]) {
                        cache[valueTopic].value = null;
                        cache[valueTopic].lastValidValue = null;
                        cache[valueTopic].lastValidTimestamp = 0;
                    }
                    if (node.enableLogging && msg.payload !== null && msg.payload !== undefined) {
                        node.log(`[${node.name || "uniflex-averager-gated"}] Invalid numeric value from ${topic}: ${msg.payload}`);
                    }
                    if (shouldOutput) publishAverage();
                    return;
                }

                if (!cache[valueTopic]) {
                    cache[valueTopic] = {
                        value: null,
                        timestamp: 0,
                        lastValidValue: null,
                        lastValidTimestamp: 0
                    };
                }
                const timestamp = Date.now();
                cache[valueTopic].value = value;
                cache[valueTopic].timestamp = timestamp;
                cache[valueTopic].lastValidValue = value;
                cache[valueTopic].lastValidTimestamp = timestamp;

                if (node.enableLogging) {
                    node.log(`[${node.name || "uniflex-averager-gated"}] Value: ${valueTopic}=${value}`);
                }
                if (shouldOutput) publishAverage();
            }
        });

        // Cleanup on node close
        node.on("close", function () {
            // No timers to clean up
        });

        // Initial status
        const valueCount = valueTopicsList.length;
        const modeText = node.outputMode === "selected-input" && node.selectedInputTopic ? `${node.outputMode} (${node.selectedInputTopic})` : node.outputMode;
        const repeatText = node.repeatWhenGateMissing ? "repeat on" : "repeat off";
        node.status({
            fill: "grey",
            shape: "dot",
            text: `Waiting (1 gate, ${valueCount} value topics, ${modeText}, ${repeatText})`
        });
    }

    RED.nodes.registerType("uniflex-averager-gated", AveragerGatedNode);
};
