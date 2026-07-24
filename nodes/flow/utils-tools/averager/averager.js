const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function AveragerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        node.inputTopics = config.inputTopics || [];
        node.outputTopic = config.outputTopic;
        node.outputMode = config.outputMode || "any-input";
        node.selectedInputTopic = (config.selectedInputTopic || "").trim();
        node.minValues = parseInt(config.minValues) || 1;
        node.precision = parseInt(config.precision) || 2;
        node.enableLogging = config.enableLogging !== false; // Default to true

        // State: cache values from input topics
        const cache = {}; // { topic: { value: number, timestamp: Date } }

        // Parse input topics from config
        const topicPatterns = node.inputTopics
            .map((t) => {
                const topic = t.manual ? t.topicManual : t.topicSelect;
                return topic ? topic.trim() : null;
            })
            .filter((t) => t);

        if (topicPatterns.length === 0) {
            node.error("No input topics configured");
            node.status({ fill: "red", shape: "dot", text: `No input topics (${ts.formatStatus()})` });
            return;
        }

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

        // Helper: Calculate average from cache
        function calculateAverage() {
            const validEntries = [];

            for (const [topic, entry] of Object.entries(cache)) {
                // Any input is valid, no age check
                if (entry.value !== null && entry.value !== undefined) {
                    validEntries.push(entry.value);
                }
            }

            return {
                avg: validEntries.length >= node.minValues ? parseFloat((validEntries.reduce((acc, val) => acc + val, 0) / validEntries.length).toFixed(node.precision)) : null,
                validCount: validEntries.length,
                totalCount: topicPatterns.length // Total configured inputs, not just cached ones
            };
        }

        // Helper: Update status only (without publishing output)
        function updateStatusOnly() {
            const result = calculateAverage();

            if (result.avg === null) {
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: `Waiting: ${result.validCount}/${result.totalCount} valid (${ts.formatStatus()})`
                });
            } else {
                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: `Ready: ${result.validCount}/${result.totalCount} valid → ${result.avg} (waiting for ${node.selectedInputTopic})`
                });
            }
        }

        // Helper: Publish average to output topic
        function publishAverage() {
            const result = calculateAverage();

            if (result.avg === null) {
                if (node.enableLogging) {
                    node.log(`[${node.name || "uniflex-averager"}] Insufficient data: ${result.validCount}/${node.minValues} min (${result.totalCount} total)`);
                }
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: `Insufficient data: ${result.validCount}/${node.minValues} (${ts.formatStatus()})`
                });
                return;
            }

            const msg = {
                topic: node.outputTopic,
                payload: result.avg
            };

            node.send(msg);

            if (node.enableLogging) {
                node.log(`[${node.name || "uniflex-averager"}] Average: ${result.avg} (${result.validCount}/${result.totalCount} inputs) -> topic: ${node.outputTopic}`);
            }

            node.status({
                fill: "green",
                shape: "dot",
                text: `${result.validCount}/${result.totalCount} valid → ${result.avg} (${ts.formatStatus()})`
            });
        }

        // Handle incoming messages
        node.on("input", function (msg) {
            const topic = msg.topic;

            // Check if topic matches any input pattern
            let matched = false;
            for (const pattern of topicPatterns) {
                if (matchesPattern(topic, pattern)) {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                return; // Ignore messages from non-matching topics
            }

            // Update cache
            // Handle null/undefined/invalid values by removing from cache (so they don't count as valid)
            const value = msg.payload === null || msg.payload === undefined ? null : parseFloat(msg.payload);
            if (value === null || isNaN(value)) {
                // Remove from cache (or mark as invalid) so it doesn't count toward valid entries
                if (cache[topic]) {
                    delete cache[topic];
                }
                // Log if it's actually a problem (not just null/undefined) and logging enabled
                if (node.enableLogging && msg.payload !== null && msg.payload !== undefined) {
                    node.log(`[${node.name || "uniflex-averager"}] Invalid numeric value from ${topic}: ${msg.payload}`);
                }
            } else {
                // Valid value - update cache
                cache[topic] = {
                    value: value,
                    timestamp: Date.now()
                };

                // Log value update if logging enabled
                if (node.enableLogging) {
                    node.log(`[${node.name || "uniflex-averager"}] Value update: ${topic}=${value}`);
                }
            }

            // Handle output based on mode
            // Output even if this value was null - we might still have enough valid values
            if (node.outputMode === "any-input") {
                // Output on any input update
                publishAverage();
            } else if (node.outputMode === "selected-input") {
                // Output only when selected input topic updates
                if (topic === node.selectedInputTopic) {
                    publishAverage();
                } else {
                    // Update status even if not the selected topic (to show current state)
                    updateStatusOnly();
                }
            }
        });

        // Cleanup on node close
        node.on("close", function () {
            // No timers to clean up
        });

        // Initial status
        const modeText = node.outputMode === "selected-input" && node.selectedInputTopic ? `${node.outputMode} (${node.selectedInputTopic})` : node.outputMode;
        node.status({
            fill: "grey",
            shape: "dot",
            text: `Waiting: ${topicPatterns.length} patterns, mode: ${modeText} (${ts.formatStatus()})`
        });
    }

    RED.nodes.registerType("uniflex-averager", AveragerNode);
};
