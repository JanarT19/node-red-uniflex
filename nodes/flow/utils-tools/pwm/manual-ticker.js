const ts = require("../../core/lib/timestamp.js");
// manual-ticker.js
// Node-RED node: manual-ticker
// Purpose: Manually send a global tick message with current timestamp and configurable period

module.exports = function (RED) {
    // Register HTTP endpoint for button click
    if (RED.httpAdmin) {
        RED.httpAdmin.post("/uniflex/manual-ticker/:id/inject", function (req, res) {
            const nodeId = req.params.id;
            const node = RED.nodes.getNode(nodeId);
            if (node && node.type === "uniflex-manual-ticker") {
                try {
                    node.sendTick();
                    res.json({ success: true });
                } catch (err) {
                    res.status(500).json({ error: err.message || String(err) });
                }
            } else {
                res.status(404).json({ error: "Node not found" });
            }
        });
    }

    function ManualTickNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.topic = config.topic || "heating/tick"; // Output topic
        node.periodSec = Number(config.periodSec ?? 1200); // Period in seconds

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        // Send tick message
        function sendTick() {
            const ts = Math.floor(Date.now() / 1000); // Current Unix timestamp in seconds
            const payload = {
                ts: ts,
                periodSec: node.periodSec
            };

            node.send({ topic: node.topic, payload });
            setStatus(`Tick sent at ${ts.formatStatus()}`, "green");
        }

        // Initial status
        setStatus(`Ready - topic: ${node.topic}, period: ${node.periodSec}s`, "grey");

        // Expose sendTick for RPC calls (button click)
        node.sendTick = sendTick;

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-manual-ticker", ManualTickNode);
};
