const http = require("http");

// Custom node to route data streams from the global context.
// Outputs the value / status / timestamp of a data stream alongside a topic.
module.exports = function (RED) {
    function ReadDataStreamsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.name = config.name;
        node.outputMode = config.outputMode;
        node.msgType = config.msgType;
        node.mappings = config.mappings || [];
        node.debugTopics = (config.debugTopics || "").trim(); // comma-separated topic prefixes; empty = no debug logging

        // Caching and state
        const previousRows = {};
        const invalidValues = ["", null, undefined];
        let lastServicesWarning = null;
        const outputModeValid = ["all", "change"];
        const msgTypeValid = ["separate", "together"];

        // Helper to track latest error timestamps to avoid spamming
        const latestErrorTimestamps = {};

        // Constants
        const MAX_TIMESTAMP_AGE = 300; // seconds
        const normalizeServiceKey = (rawKey) => {
            if (rawKey == null) return "";
            const key = String(rawKey).trim();
            return key.replace(/\.\d+$/, "");
        };

        // Match read-data-streams.html: infer service key from topic when UI save wiped keyNameSelect.
        function resolveRowServiceKey(row) {
            let key = normalizeServiceKey(row?.keyNameSelect || row?.keyNameManual || "");
            if (!key && row?.topic) {
                const parts = String(row.topic).trim().split(".");
                if (parts.length >= 2) {
                    key = normalizeServiceKey(parts[0]);
                }
            }
            return key;
        }

        function dedupeMappings(mappings) {
            const list = Array.isArray(mappings) ? mappings : [];
            const seen = new Set();
            let dropped = 0;
            const unique = [];
            list.forEach((row) => {
                const svcKey = resolveRowServiceKey(row);
                const index = Number.isInteger(row?.index) ? row.index : parseInt(row?.index, 10);
                const sig = `${svcKey}|${row?.dataType || ""}|${Number.isInteger(index) ? index : ""}|${row?.topic || ""}`;
                if (seen.has(sig)) {
                    dropped += 1;
                    return;
                }
                seen.add(sig);
                unique.push(row);
            });
            if (dropped > 0) {
                node.warn(`[read-data-streams] Ignored ${dropped} duplicate mapping(s) from config.`);
            }
            return unique;
        }
        node.mappings = dedupeMappings(node.mappings);

        function buildRowsByKey(mappings) {
            const map = Object.create(null);
            mappings.forEach((row, i) => {
                const svcKey = resolveRowServiceKey(row);
                if (!svcKey) {
                    return;
                }
                if (!map[svcKey]) {
                    map[svcKey] = [];
                }
                map[svcKey].push({ row, index: i });
            });
            return map;
        }

        const rowsByKey = buildRowsByKey(node.mappings);

        function shouldLogTopic(topicName) {
            if (!node.debugTopics) return false;
            const prefixes = node.debugTopics
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);
            if (prefixes.length === 0) return false;
            return prefixes.some((p) => topicName && topicName.startsWith(p));
        }

        function warnInvalidServicesMetadata() {
            const warning = node.controller?.servicesError || null;
            if (!warning) {
                lastServicesWarning = null;
                return;
            }
            if (warning !== lastServicesWarning) {
                node.warn(`[read-data-streams] ${warning}; configured coefficients and labels may be affected`);
                lastServicesWarning = warning;
            }
        }

        // Retrieve controller config node
        node.controller = RED.nodes.getNode(config.controller);

        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Listen for input messages

        node.on("input", (msg) => {
            warnInvalidServicesMetadata();

            // Example UDP node output:
            // payload: { TEST1S: { values: [0], status: 0, timestamp: 1750530361 } }
            const dataStreams = msg.payload;

            // Basic validation
            if (!dataStreams || typeof dataStreams !== "object") {
                node.error("Invalid payload received");
                node.status({ fill: "red", shape: "dot", text: "Invalid payload received" });
                return;
            }

            if (!outputModeValid.includes(node.outputMode)) {
                node.error(`Output mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${node.outputMode}` });
                return;
            }

            if (!msgTypeValid.includes(node.msgType)) {
                node.error(`Message type must be one of: ${msgTypeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid message type: ${node.msgType}` });
                return;
            }

            // Load fallback states from the controller
            const allStates = node.controller.allStates;
            const inputContextKey = `${node.controller.uniqueId}_input_states`;
            const inputStates = node.context().global.get(inputContextKey) || {};

            // Reset temporary variables
            const outputContext = {
                changed: false,
                time: Math.floor(Date.now() / 1000),
                separate: [],
                combined: {}
            };
            const loggedRawInputByKey = new Set();

            // Check flow context for write gating
            const flowContext = node.context().flow;
            const gatingInfo = flowContext.get("writeGating") || {};
            const now = Date.now();

            function processMappingRow(row, i) {
                const svcKey = resolveRowServiceKey(row);
                const topic = row.topic;

                // Check if this key is gated (recently written by write node)
                if (gatingInfo[svcKey]) {
                    const age = now - gatingInfo[svcKey];
                    // Get gating duration from write nodes (default 1500ms)
                    const gatingMs = 1500; // Could be made configurable

                    if (age < gatingMs) {
                        // Skip this output - it was recently written
                        return;
                    }
                }

                // Priority: 1) this msg; 2) UDP input cache; 3) row cache; 4) /allstates
                const stream = dataStreams?.[svcKey] ?? inputStates?.[svcKey];
                const inThisMsg = Object.prototype.hasOwnProperty.call(dataStreams || {}, svcKey);
                const cached = previousRows[i];
                const allState = allStates?.[svcKey];

                const status = stream?.status ?? cached?.status ?? allState?.status;
                const values = stream?.values ?? cached?.values ?? allState?.values;
                const timestamp = stream?.timestamp ?? cached?.timestamp ?? allState?.timestamp;
                if (stream && shouldLogTopic(topic) && !loggedRawInputByKey.has(svcKey)) {
                    loggedRawInputByKey.add(svcKey);
                    node.log(`[read-data-streams] IN ${svcKey} values=${JSON.stringify(stream.values)}, status=${stream.status}, ts=${stream.timestamp}`);
                }

                // Input message or row-specific validation
                if (invalidValues.includes(topic)) {
                    node.error(`Topic undefined for ${svcKey}`);
                    node.status({ fill: "red", shape: "dot", text: `Topic undefined for ${svcKey}` });
                    return;
                }

                if ([status, values, timestamp].includes(undefined)) {
                    if (shouldLogTopic(topic) && allowLoggingWithoutSpamming(`missing-debug:${svcKey}`, outputContext, 30)) {
                        node.log(`[read-data-streams] Missing data for ${svcKey}: status=${status}, values=${JSON.stringify(values)}, ts=${timestamp}`);
                    }
                    if (allowLoggingWithoutSpamming(`unknown:${svcKey}`, outputContext, 30)) {
                        if (!svcKey) {
                            node.warn(`Invalid read node configuration: empty service key for topic '${topic}' -- remove or fix this row`);
                            node.status({ fill: "red", shape: "dot", text: `Config error: empty key, topic:${topic}` });
                        } else {
                            node.warn(`No data yet for '${svcKey}' (topic: ${topic}) -- ` + "not in this UDP packet, input cache, row cache, or /allstates");
                            node.status({ fill: "yellow", shape: "dot", text: `No data: '${svcKey}' topic:${topic}` });
                        }
                    }

                    return;
                }

                // Calculate the output based on the row configuration
                let output = getOutput(node, row, { status, values, timestamp });

                // Check for outdated timestamps, set output to null if too old
                if (outputContext.time - timestamp > MAX_TIMESTAMP_AGE) {
                    if (allowLoggingWithoutSpamming(`outdated:${svcKey}`, outputContext, 30)) {
                        node.warn(`Data stream ${svcKey} outdated: ${outputContext.time - timestamp} seconds ago`);
                        node.status({ fill: "yellow", shape: "dot", text: `Data stream ${svcKey} outdated` });
                    }

                    output = null;
                }

                const changed = cached?.output !== output;

                // Update the previous state
                // PS. variable 'cached' points to the object that was at previousRows[i] at the time of assignment, it's not updated
                previousRows[i] = { status, values, timestamp, output };

                // UDP sends one key per packet: only emit rows for the key in this message.
                if (node.outputMode === "all" && node.msgType !== "together" && !inThisMsg) {
                    return;
                }

                if (node.outputMode === "change" && node.msgType !== "together" && !changed) {
                    return;
                }

                // Prepare the output msg
                const outMsg = {
                    ...msg,
                    topic: topic,
                    payload: output,
                    controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host }
                };
                // Full member array from this UDP/HTTP packet (MBN201W.3 msg still carries all members).
                if (row.dataType === "value" && Array.isArray(values) && values.length > 0) {
                    outMsg.streamValues = values;
                }

                if (shouldLogTopic(topic)) {
                    const memberIdx = Number.isInteger(row.index) ? row.index : parseInt(row.index, 10);
                    const memberValue = Number.isInteger(memberIdx) && memberIdx > 0 ? values?.[memberIdx - 1] : undefined;
                    node.log(
                        `[read-data-streams] ${svcKey} -> topic=${topic}, member=${memberIdx}, memberValue=${memberValue}, output=${output} (payload), status=${status}, ts=${timestamp}`
                    );
                }

                outputContext.separate.push(outMsg);
                outputContext.combined[topic] = output;
                outputContext.changed ||= changed;
            }

            // together: rebuild full combined payload from all rows (uses cache for keys not in this msg)
            if (node.msgType === "together") {
                node.mappings.forEach((row, i) => processMappingRow(row, i));
            } else {
                const packetKeys = Object.keys(dataStreams);
                for (let ki = 0; ki < packetKeys.length; ki++) {
                    const svcKey = packetKeys[ki];
                    const entries = rowsByKey[svcKey];
                    if (!entries) {
                        continue;
                    }
                    for (let ei = 0; ei < entries.length; ei++) {
                        const entry = entries[ei];
                        processMappingRow(entry.row, entry.index);
                    }
                }
            }

            handleOutput(node, msg, outputContext);
        });

        // Send error messages without spamming
        function allowLoggingWithoutSpamming(topic, outputContext, wait = 10) {
            if (!latestErrorTimestamps[topic] || outputContext.time - latestErrorTimestamps[topic] > wait) {
                latestErrorTimestamps[topic] = outputContext.time;

                return true;
            }

            return false;
        }

        // Function to handle sending output messages based on configuration
        function handleOutput(node, msg, ctx) {
            const rows = node.mappings.length;

            // Send each output message separately
            if (node.msgType === "separate") {
                const count = ctx.separate.length;
                const keys = [...new Set(ctx.separate.map((m) => m.topic).filter((k) => !!k))];
                const shownKeys = keys.slice(0, 8).join(", ");
                const suffix = keys.length > 8 ? "..." : "";

                node.status({ fill: count === 0 ? "grey" : "green", shape: "dot", text: `Output ${count} of ${rows} keys${count > 0 ? `: ${shownKeys}${suffix}` : ""}` });
                ctx.separate.forEach((m) => node.send(m));
                return;
            }

            // Send {topic: value} pairs
            if (node.msgType === "together") {
                const noSend = node.outputMode === "change" && !ctx.changed;

                const outMsg = { ...msg, payload: ctx.combined };
                delete outMsg.topic;

                const count = noSend ? 0 : Object.keys(ctx.combined).length;
                const keys = noSend ? [] : Object.keys(ctx.combined);
                const shownKeys = keys.slice(0, 8).join(", ");
                const suffix = keys.length > 8 ? "..." : "";

                node.status({ fill: count === 0 ? "grey" : "green", shape: "dot", text: `Output ${count} of ${rows} keys${count > 0 ? `: ${shownKeys}${suffix}` : ""}` });
                if (count > 0) node.send(outMsg);
                return;
            }

        }

        // Function to retrieve the output value based on the row configuration
        function getOutput(node, row, obj = {}) {
            const { status, values, timestamp } = obj;
            const dataType = row.dataType;

            if (dataType === "value") {
                // Retrieve value at the specified index (adjust for 0-based index)
                const index = row.index - 1;
                const coefficient = formatCoefficient(node, row);
                const value = values?.[index];
                if (value === undefined || value === null || value === "") {
                    return null;
                }
                if (typeof value === "string" && value.trim().toUpperCase() === "UNKN") {
                    return null;
                }
                const n = Number(value);
                if (!Number.isFinite(n)) {
                    return null;
                }
                return parseFloat((n / coefficient).toFixed(2));
            }

            if (dataType === "status") return status ?? null;
            if (dataType === "timestamp") return timestamp ?? null;

            return null;
        }

        // Return the coefficient for the specified row, or default to 1 if not found
        // Manual entries use only row.coefficient, not controller's conv_coef
        function formatCoefficient(node, row) {
            const services = node.controller?.services || {};
            const keyName = resolveRowServiceKey(row);

            let coef = row.coefficient;

            // Only use controller's conv_coef for non-manual entries
            if (!row.manual && keyName && services[keyName]) {
                coef = services[keyName]?.conv_coef || coef;
            }

            if (invalidValues.includes(coef)) {
                coef = 1;
            }

            return parseFloat(coef);
        }
    }

    RED.nodes.registerType("uniflex-read-data-streams", ReadDataStreamsNode);
};
