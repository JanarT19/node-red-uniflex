const ts = require("../../../core/lib/timestamp.js");
module.exports = function (RED) {
    function GasWatchdogNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.enableCmdTopic = (config.enableCmdTopic || "gas_enable").trim();
        node.needHeatTopic = (config.needHeatTopic || "HQV.1").trim();
        node.flameTopic = (config.flameTopic || "IMODW.4").trim();
        node.pumpHeatingTopic = (config.pumpHeatingTopic || "IMODW.2").trim();
        node.dhwActiveTopic = (config.dhwActiveTopic || "IMODW.3").trim();
        node.blockTopic = (config.blockTopic || "").trim();
        node.outAvailTopic = (config.outAvailTopic || "HAVW.1").trim();

        node.needThresholdKw = Math.max(0, Number(config.needThresholdKw ?? 0.1));
        node.noEvidenceTimeoutSec = Math.max(10, Number(config.noEvidenceTimeoutSec ?? 600));
        node.recoveryClearSec = Math.max(10, Number(config.recoveryClearSec ?? 180));
        node.ignoreWhileDhw = config.ignoreWhileDhw !== false;

        let enableCmd = 0;
        let needHeat = 0;
        let flame = 0;
        let pumpHeating = 0;
        let dhwActive = 0;
        let block = 0;

        let unavailable = 0;
        let noEvidenceSince = null;
        let recoverySince = null;
        let lastAvail = null;

        function b01(v) {
            return (v == null || !Number.isFinite(Number(v)) ? null : (Number(v) !== 0 ? 1 : 0));
        }
        function sendProblem() {
            if (!node.outAvailTopic) return;
            const problem = unavailable ? 1 : 0;
            if (problem === lastAvail) return;
            lastAvail = problem;
            node.send({ topic: node.outAvailTopic, payload: problem });
        }
        function compute() {
            const now = Date.now();
            const evidence = flame || pumpHeating ? 1 : 0;
            const holdByDhw = node.ignoreWhileDhw && dhwActive ? 1 : 0;
            const monitorActive = enableCmd && needHeat && !holdByDhw && !block;

            if (!monitorActive) {
                unavailable = 0;
                noEvidenceSince = null;
                recoverySince = null;
                sendProblem();
                node.status({ fill: "grey", shape: "dot", text: holdByDhw ? "hold:dhw" : "idle" });
                return;
            }

            if (!evidence) {
                recoverySince = null;
                if (noEvidenceSince == null) noEvidenceSince = now;
                if (now - noEvidenceSince >= node.noEvidenceTimeoutSec * 1000) unavailable = 1;
            } else {
                noEvidenceSince = null;
                if (unavailable) {
                    if (recoverySince == null) recoverySince = now;
                    if (now - recoverySince >= node.recoveryClearSec * 1000) unavailable = 0;
                } else {
                    recoverySince = null;
                }
            }

            sendProblem();
            const reason = unavailable ? "no-evidence" : "ok";
            node.status({
                fill: unavailable ? "red" : "green",
                shape: "dot",
                text: `problem=${unavailable ? 1 : 0} reason=${reason} fl=${flame} ph=${pumpHeating} dhw=${dhwActive}`
            });
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            if (t === node.enableCmdTopic) {
                const bit = b01(msg.payload);
                if (bit === null) return;
                enableCmd = bit;
            } else if (t === node.needHeatTopic) {
                const n = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (n === null) return;
                needHeat = n > node.needThresholdKw ? 1 : 0;
            } else if (t === node.flameTopic) {
                const bit = b01(msg.payload);
                if (bit === null) return;
                flame = bit;
            } else if (t === node.pumpHeatingTopic) {
                const bit = b01(msg.payload);
                if (bit === null) return;
                pumpHeating = bit;
            } else if (t === node.dhwActiveTopic) {
                const bit = b01(msg.payload);
                if (bit === null) return;
                dhwActive = bit;
            } else if (t === node.blockTopic) {
                const bit = b01(msg.payload);
                if (bit === null) return;
                block = bit;
            } else return;
            compute();
        });
    }

    RED.nodes.registerType("uniflex-gas-watchdog", GasWatchdogNode);
};
