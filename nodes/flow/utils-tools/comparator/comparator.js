const ts = require("../../core/lib/timestamp.js");
// comparator.js
// Node-RED node: comparator
// Purpose: Compare values with hysteresis using selectable operators.

module.exports = function (RED) {
    function ComparatorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.operator = config.operator || ">"; // ">", "<", "in-range", "out-of-range" (legacy "<>" "><" mapped below)
        if (node.operator === "<>") node.operator = "out-of-range";
        if (node.operator === "><") node.operator = "in-range";

        // Input 1 is always a topic
        node.inputTopic1 = config.inputTopic1 || "";
        node.inputComment1 = config.inputComment1 || "";

        // Input 2 configuration
        node.input2Type = config.input2Type || "topic"; // "topic" or "fixed"
        node.inputTopic2 = config.inputTopic2 || "";
        node.inputComment2 = config.inputComment2 || "";
        node.inputFixed2 = config.inputFixed2 !== undefined && config.inputFixed2 !== "" ? Number(config.inputFixed2) : null;

        // Input 3 configuration (for in-range / out-of-range operators)
        node.input3Type = config.input3Type || "topic"; // "topic" or "fixed"
        node.inputTopic3 = config.inputTopic3 || "";
        node.inputComment3 = config.inputComment3 || "";
        node.inputFixed3 = config.inputFixed3 !== undefined && config.inputFixed3 !== "" ? Number(config.inputFixed3) : null;

        node.outputTopic = config.outputTopic || "";
        node.outputComment = config.outputComment || "";
        node.hysteresis = Number(config.hysteresis ?? 0.0); // Hysteresis value
        node.enableSystemLog = config.enableSystemLog === true;
        // Status fill colors for output states (Node-RED: red, green, yellow, blue, grey)
        node.colorWhen0 = config.colorWhen0 || "blue";
        node.colorWhen1 = config.colorWhen1 || "green";

        // ---- STATE
        let value1 = null; // Current value from input 1 (always from topic)
        let value2 = null; // Current value from input 2
        let value3 = null; // Current value from input 3 (for <> and >< operators)
        let outputState = 0; // Current output state (0 or 1)
        let lastOutputState = null; // Track last output state for change detection

        // Initialize fixed values
        if (node.input2Type === "fixed" && node.inputFixed2 !== null) {
            value2 = node.inputFixed2;
        }
        if ((node.operator === "in-range" || node.operator === "out-of-range") && node.input3Type === "fixed" && node.inputFixed3 !== null) {
            value3 = node.inputFixed3;
        }

        // Helper function for system logging
        function systemLog(level, message) {
            if (node.enableSystemLog) {
                if (RED && RED.log) {
                    RED.log[level](message);
                } else {
                    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${node.name || "comparator"}] ${message}`);
                }
            }
        }

        function parseValue(payload) {
            if (payload === null || payload === undefined) return null;
            if (Array.isArray(payload)) {
                return payload.length > 0 ? Number(payload[0]) : null;
            }
            return Number(payload);
        }

        function getValue2() {
            if (node.input2Type === "fixed") {
                return node.inputFixed2;
            }
            return value2;
        }

        function getValue3() {
            if (node.input3Type === "fixed") {
                return node.inputFixed3;
            }
            return value3;
        }

        function evaluateComparison() {
            if (value1 === null) {
                return null; // Can't evaluate if input1 is missing
            }

            const v2 = getValue2();

            if (node.operator === "in-range" || node.operator === "out-of-range") {
                // Input 2 and Input 3 define the range [low, high]. Check if value1 is inside or outside.
                const v3 = getValue3();
                if (v2 === null || v3 === null) {
                    return null; // Can't evaluate if any value is missing
                }
                const low = Math.min(v2, v3);
                const high = Math.max(v2, v3);
                const inRange = value1 >= low && value1 <= high;
                if (node.operator === "in-range") {
                    return inRange ? 1 : 0;
                } else {
                    return inRange ? 0 : 1; // out-of-range
                }
            } else {
                // > and < operators only need input2
                if (v2 === null) {
                    return null; // Can't compare if value2 is missing
                }

                // Hysteresis logic for > and < operators:
                if (node.operator === ">") {
                    // Greater than
                    if (outputState === 0) {
                        // Currently outputting 0, switch to 1 when value1 > v2 + hysteresis
                        if (value1 > v2 + node.hysteresis) {
                            return 1;
                        }
                        return 0;
                    } else {
                        // Currently outputting 1, switch to 0 when value1 <= v2 - hysteresis
                        if (value1 <= v2 - node.hysteresis) {
                            return 0;
                        }
                        return 1;
                    }
                } else if (node.operator === "<") {
                    // Less than
                    if (outputState === 0) {
                        // Currently outputting 0, switch to 1 when value1 < v2 - hysteresis
                        if (value1 < v2 - node.hysteresis) {
                            return 1;
                        }
                        return 0;
                    } else {
                        // Currently outputting 1, switch to 0 when value1 >= v2 + hysteresis
                        if (value1 >= v2 + node.hysteresis) {
                            return 0;
                        }
                        return 1;
                    }
                }
            }

            return null;
        }

        function updateOutput() {
            const newOutputState = evaluateComparison();

            if (newOutputState === null) {
                // Missing input values - don't update output
                return;
            }

            if (newOutputState !== outputState) {
                const oldState = outputState;
                outputState = newOutputState;
                lastOutputState = oldState;

                // Send output message
                const msg = {
                    payload: outputState
                };

                if (node.outputTopic) {
                    msg.topic = node.outputTopic;
                }

                node.send(msg);

                let msgText;
                const v2 = getValue2();
                if (node.operator === "in-range" || node.operator === "out-of-range") {
                    const v3 = getValue3();
                    const low = v2 !== null && v3 !== null ? Math.min(v2, v3) : null;
                    const high = v2 !== null && v3 !== null ? Math.max(v2, v3) : null;
                    const opText = node.operator === "in-range" ? "in" : "out of";
                    msgText = `Output changed: ${oldState} → ${outputState} (value=${value1 !== null ? value1.toFixed(2) : "null"} ${opText} range [${low !== null ? low.toFixed(2) : "?"}, ${high !== null ? high.toFixed(2) : "?"}])`;
                } else {
                    msgText = `Output changed: ${oldState} → ${outputState} (value1=${value1 !== null ? value1.toFixed(2) : "null"} ${node.operator} value2=${v2 !== null ? v2.toFixed(2) : "null"})`;
                }

                node.log(msgText);
                systemLog("info", msgText);
            }

            updateStatus();
        }

        function updateStatus() {
            let statusText = "";
            const v2 = getValue2();

            if (node.operator === "in-range" || node.operator === "out-of-range") {
                const v3 = getValue3();
                if (value1 !== null && v2 !== null && v3 !== null) {
                    const low = Math.min(v2, v3);
                    const high = Math.max(v2, v3);
                    const opText = node.operator === "in-range" ? "in" : "out of";
                    statusText = `value: ${value1.toFixed(2)} ${opText} [${low.toFixed(2)}, ${high.toFixed(2)}] = ${outputState}`;
                } else {
                    const missing = [];
                    if (value1 === null) missing.push("value1");
                    if (v2 === null) missing.push("value2");
                    if (v3 === null) missing.push("value3");
                    statusText = `Waiting for: ${missing.join(", ")}`;
                }
            } else {
                if (value1 !== null && v2 !== null) {
                    statusText = `value1: ${value1.toFixed(2)} ${node.operator} value2: ${v2.toFixed(2)} = ${outputState}`;
                } else {
                    const missing = [];
                    if (value1 === null) missing.push("value1");
                    if (v2 === null) missing.push("value2");
                    statusText = `Waiting for: ${missing.join(", ")}`;
                }
            }

            // Determine color from config (output 0 / output 1)
            let fill = "grey";
            if (node.operator === "in-range" || node.operator === "out-of-range") {
                const v2 = getValue2();
                const v3 = getValue3();
                if (value1 !== null && v2 !== null && v3 !== null) {
                    fill = outputState === 1 ? node.colorWhen1 || "green" : node.colorWhen0 || "blue";
                }
            } else {
                const v2 = getValue2();
                if (value1 !== null && v2 !== null) {
                    fill = outputState === 1 ? node.colorWhen1 || "green" : node.colorWhen0 || "blue";
                }
            }

            node.status({ fill, shape: "dot", text: statusText });
        }

        // Initialize status
        updateStatus();

        // Trigger initial evaluation if all fixed values are set
        const v2 = getValue2();
        if (node.operator === "in-range" || node.operator === "out-of-range") {
            const v3 = getValue3();
            if (value1 !== null && v2 !== null && v3 !== null) {
                updateOutput();
            }
        } else {
            if (value1 !== null && v2 !== null) {
                updateOutput();
            }
        }

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = msg.payload;

            // Build list of expected topics
            const expectedTopics = [];
            if (node.inputTopic1) expectedTopics.push(node.inputTopic1);
            if (node.input2Type === "topic" && node.inputTopic2) expectedTopics.push(node.inputTopic2);
            if ((node.operator === "in-range" || node.operator === "out-of-range") && node.input3Type === "topic" && node.inputTopic3) expectedTopics.push(node.inputTopic3);

            // Handle direct wire input (no topic) when no topics are configured
            if (expectedTopics.length === 0 && t === "") {
                // Direct wire input - assume it's for input1
                const newValue1 = parseValue(p);
                if (newValue1 !== null && !isNaN(newValue1)) {
                    if (value1 === null || Math.abs(value1 - newValue1) > 0.0001) {
                        value1 = newValue1;
                        updateOutput();
                    } else {
                        value1 = newValue1;
                    }
                }
                return;
            }

            // If we have expected topics and this message doesn't match, ignore it
            if (expectedTopics.length > 0 && !expectedTopics.includes(t)) {
                return;
            }

            // Process input 1 (always from topic)
            if (t === node.inputTopic1) {
                const newValue1 = parseValue(p);
                if (newValue1 !== null && !isNaN(newValue1)) {
                    if (value1 === null || Math.abs(value1 - newValue1) > 0.0001) {
                        value1 = newValue1;
                        updateOutput();
                    } else {
                        value1 = newValue1;
                    }
                } else {
                    if (node.enableSystemLog) {
                        node.warn(`Invalid value for input 1: ${JSON.stringify(p)}`);
                    }
                }
                return;
            }

            // Process input 2
            if (node.input2Type === "topic" && t === node.inputTopic2) {
                const newValue2 = parseValue(p);
                if (newValue2 !== null && !isNaN(newValue2)) {
                    if (value2 === null || Math.abs(value2 - newValue2) > 0.0001) {
                        value2 = newValue2;
                        updateOutput();
                    } else {
                        value2 = newValue2;
                    }
                } else {
                    if (node.enableSystemLog) {
                        node.warn(`Invalid value for input 2: ${JSON.stringify(p)}`);
                    }
                }
                return;
            }

            // Process input 3 (for in-range / out-of-range operators)
            if ((node.operator === "in-range" || node.operator === "out-of-range") && node.input3Type === "topic" && t === node.inputTopic3) {
                const newValue3 = parseValue(p);
                if (newValue3 !== null && !isNaN(newValue3)) {
                    if (value3 === null || Math.abs(value3 - newValue3) > 0.0001) {
                        value3 = newValue3;
                        updateOutput();
                    } else {
                        value3 = newValue3;
                    }
                } else {
                    if (node.enableSystemLog) {
                        node.warn(`Invalid value for input 3: ${JSON.stringify(p)}`);
                    }
                }
                return;
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-comparator", ComparatorNode);
};
