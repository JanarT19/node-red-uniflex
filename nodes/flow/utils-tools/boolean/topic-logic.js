const ts = require("../../core/lib/timestamp.js");
// uniflex-topic-logic.js
// Node-RED node: uniflex-topic-logic
// Purpose: Perform boolean logic operations on topic-based inputs (0/1) with configurable logic gates.

module.exports = function (RED) {
    function TopicLogicNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.outputTopic = config.outputTopic || "";
        node.gateType = config.gateType || "or";
        node.outputMode = config.outputMode || "all";
        node.formatMode = config.formatMode || "passthrough";
        node.enableSystemLog = config.enableSystemLog === true;
        node.statusColor0 = config.statusColor0 || "green"; // Color for output 0
        node.statusColor1 = config.statusColor1 || "yellow"; // Color for output 1

        // Parse input topics and comments (arrays)
        if (Array.isArray(config.inputTopics)) {
            node.inputTopics = config.inputTopics.filter((t) => t && t.length > 0);
        } else {
            node.inputTopics = (config.inputTopics || "")
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
        }

        if (Array.isArray(config.inputComments)) {
            node.inputComments = config.inputComments.filter((c) => c !== null && c !== undefined);
        } else {
            node.inputComments = [];
        }

        // Ensure arrays are same length
        while (node.inputComments.length < node.inputTopics.length) {
            node.inputComments.push("");
        }
        while (node.inputTopics.length < node.inputComments.length) {
            node.inputTopics.push("");
        }

        const numInputs = node.inputTopics.length;

        // ---- STATE
        let inputStates = Array(numInputs).fill(0); // 0=false, 1=true

        // Logic gate functions
        const gates = {
            and: (states) => states.every((s) => s === 1),
            or: (states) => states.some((s) => s === 1),
            nand: (states) => !states.every((s) => s === 1),
            nor: (states) => !states.some((s) => s === 1),
            xor: (states) => states.filter((s) => s === 1).length === 1,
            xnor: (states) => states.filter((s) => s === 1).length !== 1
        };

        // Helper function for system logging
        function systemLog(level, message) {
            if (node.enableSystemLog) {
                if (RED && RED.log) {
                    RED.log[level](message);
                } else {
                    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${node.name || "topic-logic"}] ${message}`);
                }
            }
        }

        function evaluateLogic() {
            const gateFunc = gates[node.gateType];
            if (!gateFunc) {
                node.error(`Unknown gate type: ${node.gateType}`);
                return false;
            }
            return gateFunc(inputStates) ? 1 : 0;
        }

        function updateStatus() {
            const result = evaluateLogic();
            const activeCount = inputStates.filter((s) => s === 1).length;

            let statusText = `${activeCount}/${numInputs} active, ${node.gateType.toUpperCase()}: ${result ? "1" : "0"}`;

            // List active inputs
            const activeInputs = [];
            for (let i = 0; i < numInputs; i++) {
                if (inputStates[i] === 1) {
                    const comment = node.inputComments[i] || `Input ${i + 1}`;
                    activeInputs.push(comment);
                }
            }
            if (activeInputs.length > 0 && activeInputs.length <= 3) {
                statusText += ` [${activeInputs.join(", ")}]`;
            } else if (activeInputs.length > 3) {
                statusText += ` [${activeInputs.slice(0, 2).join(", ")}, ...]`;
            }

            // Use configured status colors
            const fill = result === 1 ? node.statusColor1 : node.statusColor0;
            node.status({ fill, shape: "dot", text: statusText });
        }

        function publishOutput(msg, result) {
            const invalidValues = ["", null, undefined];

            // Always send 0/1 to output topic (for iolayer) if configured
            // This is independent of output mode and format mode
            if (node.outputTopic) {
                node.send({
                    topic: node.outputTopic,
                    payload: result
                });
            }

            // Check output mode for default output
            const shouldOutput = node.outputMode === "all" || (node.outputMode === "true" && result === 1) || (node.outputMode === "false" && result === 0);

            if (!shouldOutput) {
                // Update status but keep the configured color (don't override with grey)
                const activeCount = inputStates.filter((s) => s === 1).length;
                const fill = result === 1 ? node.statusColor1 : node.statusColor0;
                node.status({ fill, shape: "dot", text: `${activeCount}/${numInputs} active, ${node.gateType.toUpperCase()}: ${result ? "1" : "0"} (no default output)` });
                return;
            }

            let outMsg = null;

            // Passthrough mode: send the original message
            if (node.formatMode === "passthrough") {
                outMsg = { ...msg };
            }
            // Comprehensive mode: send the boolean result with metadata
            else if (node.formatMode === "comprehensive") {
                outMsg = { ...msg, payload: result };
                delete outMsg.topic;

                if (!invalidValues.includes(node.outputTopic)) outMsg.topic = node.outputTopic;

                outMsg.inputs = inputStates.map((state, idx) => ({
                    index: idx,
                    active: state === 1,
                    comment: node.inputComments[idx] || `Input ${idx + 1}`,
                    topic: node.inputTopics[idx] || ""
                }));
            }

            // Send to default output (if format mode allows)
            if (outMsg) {
                node.send(outMsg);
            }
        }

        updateStatus();

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = msg.payload;

            // Check each input topic
            let stateChanged = false;
            for (let i = 0; i < numInputs; i++) {
                if (node.inputTopics[i] && t === node.inputTopics[i]) {
                    const val = Array.isArray(p) ? p[0] : p;
                    const newState = (val == null || !Number.isFinite(Number(val)) ? null : (Number(val) !== 0 ? 1 : 0));
                    if (newState === null) {
                        continue;
                    }
                    const comment = node.inputComments[i] || `Input ${i + 1}`;

                    if (newState !== inputStates[i]) {
                        inputStates[i] = newState;
                        stateChanged = true;

                        if (newState === 1) {
                            const logMsg = `${comment} ACTIVE (topic: ${t})`;
                            node.log(logMsg);
                            systemLog("info", logMsg);
                        } else {
                            const logMsg = `${comment} INACTIVE (topic: ${t})`;
                            node.log(logMsg);
                            systemLog("info", logMsg);
                        }
                    }
                    break;
                }
            }

            if (stateChanged) {
                const result = evaluateLogic();
                updateStatus();
                publishOutput(msg, result);
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-topic-logic", TopicLogicNode);
};
