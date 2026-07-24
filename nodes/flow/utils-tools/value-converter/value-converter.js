const ts = require("../../core/lib/timestamp.js");
// uniflex-value-converter.js
// Node-RED node: uniflex-value-converter
// Purpose: Convert/transform values with configurable operations (multiply, divide, add, subtract, custom expression)

module.exports = function (RED) {
    function ValueConverterNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.inputTopic = config.inputTopic || "";
        node.outputTopic = config.outputTopic || "";
        node.operation = config.operation || "multiply";
        node.value = Number(config.value ?? 1.0);
        node.customExpression = config.customExpression || "value * 100";
        node.outputInt = config.outputInt === true;
        node.enableSystemLog = config.enableSystemLog === true;

        // ---- STATE
        let lastInputValue = null;
        let lastOutputValue = null;

        // Helper function for system logging
        function systemLog(level, message) {
            if (node.enableSystemLog) {
                if (RED && RED.log) {
                    RED.log[level](message);
                } else {
                    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${node.name || "value-converter"}] ${message}`);
                }
            }
        }

        // Helper function to extract value from payload
        function extractValue(payload) {
            if (Array.isArray(payload)) {
                // Use first element if array
                return payload[0];
            }
            return payload;
        }

        // Helper function to convert value
        function convertValue(inputValue) {
            if (inputValue === null || inputValue === undefined) {
                return null;
            }

            const num = Number(inputValue);
            if (isNaN(num)) {
                node.warn(`Invalid numeric value: ${inputValue}`);
                return null;
            }

            let result;

            switch (node.operation) {
                case "multiply":
                    result = num * node.value;
                    break;
                case "divide":
                    if (node.value === 0) {
                        node.error("Division by zero!");
                        return null;
                    }
                    result = num / node.value;
                    break;
                case "add":
                    result = num + node.value;
                    break;
                case "subtract":
                    result = num - node.value;
                    break;
                case "custom":
                    // Custom JavaScript expression
                    // Available variables: value (input), configValue (node.value)
                    try {
                        const value = num;
                        const configValue = node.value;
                        result = eval(node.customExpression);
                        if (typeof result !== "number" || isNaN(result)) {
                            node.error(`Custom expression returned invalid result: ${result}`);
                            return null;
                        }
                    } catch (error) {
                        node.error(`Custom expression error: ${error.message}`);
                        return null;
                    }
                    break;
                default:
                    node.error(`Unknown operation: ${node.operation}`);
                    return null;
            }

            if (node.outputInt && typeof result === "number" && !isNaN(result)) {
                result = Math.round(result);
            }
            return result;
        }

        function updateStatus() {
            if (lastInputValue === null || lastOutputValue === null) {
                node.status({ fill: "grey", shape: "dot", text: "Waiting for input..." });
                return;
            }

            // Format values (handle arrays by showing the converted index)
            let inStr = String(lastInputValue);
            let outStr;

            // Handle output value display
            if (Array.isArray(lastOutputValue)) {
                // Show array format
                outStr = `[${lastOutputValue.join(", ")}]`;
            } else {
                outStr = String(lastOutputValue);
            }

            // If values are numbers, format with reasonable precision
            if (typeof lastInputValue === "number") {
                inStr = lastInputValue % 1 === 0 ? lastInputValue.toString() : lastInputValue.toFixed(3).replace(/\.?0+$/, "");
            }
            if (typeof lastOutputValue === "number") {
                outStr = lastOutputValue % 1 === 0 ? lastOutputValue.toString() : lastOutputValue.toFixed(3).replace(/\.?0+$/, "");
            } else if (Array.isArray(lastOutputValue)) {
                // Format array elements
                outStr = `[${lastOutputValue
                    .map((v) =>
                        typeof v === "number" && v % 1 === 0
                            ? v.toString()
                            : Number(v)
                                  .toFixed(3)
                                  .replace(/\.?0+$/, "")
                    )
                    .join(", ")}]`;
            }

            node.status({
                fill: "blue",
                shape: "dot",
                text: `in: ${inStr} out: ${outStr}`
            });
        }

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = msg.payload;

            // Only process if input topic matches (if configured)
            if (node.inputTopic && t !== node.inputTopic) {
                return; // Ignore messages with different topics
            }

            // Extract input value
            const inputValue = extractValue(p);

            // Convert value
            const outputValue = convertValue(inputValue);

            if (outputValue === null) {
                return; // Conversion failed, don't send output
            }

            // Store last values for status display
            lastInputValue = inputValue;
            lastOutputValue = outputValue;

            // Create output message
            let outMsg = { ...msg };
            outMsg.payload = outputValue;

            // Set output topic if configured
            if (node.outputTopic) {
                outMsg.topic = node.outputTopic;
            }

            updateStatus();
            node.send(outMsg);

            // Only log if system logging is enabled
            if (node.enableSystemLog) {
                const logMsg = `Converted ${inputValue} → ${outputValue} (${node.operation})`;
                node.log(logMsg);
                systemLog("info", logMsg);
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-value-converter", ValueConverterNode);
};
