const RuleManager = require("./RuleManager");
const ts = require("../../core/lib/timestamp.js");

// Boolean logic node
// Refactored from node-red-contrib-bool-gate: https://flows.nodered.org/node/node-red-contrib-bool-gate
module.exports = function (RED) {
    function BooleanLogicNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Retrieve configuration settings
        node.rules = config.rules || [];
        node.topic = config.outputTopic ?? null;
        node.type = config.gateType || "and";
        node.mode = config.outputMode || "all";
        node.format = config.formatMode || "passthrough";

        this.ruleManager = new RuleManager(RED, node, node.type);

        // Validation constants
        const invalidValues = ["", null, undefined];

        // Store all rules during the initialization
        this.ruleManager.storeRules(node.rules).then((obj) => {
            node.status({ fill: "grey", shape: "dot", text: "Node initialized" });
        });

        // Listen for input messages
        node.on("input", function (msg) {
            this.ruleManager.updateState(msg).then((obj) => {
                const { result, parameters, metadata } = obj;

                if (node.mode === "all" || (node.mode === "true" && result) || (node.mode === "false" && !result)) {
                    let outMsg = null;

                    // Passthrough mode: send the original message
                    if (node.format === "passthrough") {
                        outMsg = { ...msg };
                    }

                    // Result mode: send the boolean result alongside parameters
                    else if (node.format === "comprehensive") {
                        outMsg = { ...msg, payload: result, parameters, trigger: {} };
                        delete outMsg.topic;

                        if (!invalidValues.includes(node.topic)) outMsg.topic = node.topic;
                        if (!invalidValues.includes(msg.payload)) outMsg.trigger.payload = msg.payload;
                        if (!invalidValues.includes(msg.topic)) outMsg.trigger.topic = msg.topic;
                    }

                    node.status({ fill: result ? "green" : "red", shape: "dot", text: `${metadata.validated} of ${metadata.total}, output: ${result} (${ts.formatStatus()})` });

                    node.send(outMsg);
                } else {
                    node.status({ fill: "grey", shape: "dot", text: `${metadata.validated} of ${metadata.total}, no output (${ts.formatStatus()})` });
                }
            });
        });
    }

    RED.nodes.registerType("uniflex-boolean-logic", BooleanLogicNode);
};
