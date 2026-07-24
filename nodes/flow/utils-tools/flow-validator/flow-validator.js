const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function FlowValidatorConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG ----
        node.name = config.name;
        node.enabled = config.enabled !== false; // Default to true

        // ---- STATUS ----

        // Set initial status
        node.status({
            fill: node.enabled ? "green" : "grey",
            shape: "dot",
            text: node.enabled ? "Validation enabled" : "Validation disabled"
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-flow-validator", FlowValidatorConfigNode);
};
