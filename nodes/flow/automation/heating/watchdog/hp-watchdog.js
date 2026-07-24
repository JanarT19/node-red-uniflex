const ts = require("../../../core/lib/timestamp.js");
module.exports = function (RED) {
    function HpWatchdogNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.enableCmdTopic = (config.enableCmdTopic || "hp_enable").trim();
        node.needHeatTopic = (config.needHeatTopic || "HQV.1").trim();
        node.compSpeedTopic = (config.compSpeedTopic || "ESCSV").trim();
        node.defrostTopic = (config.defrostTopic || "").trim();
        node.blockTopic = (config.blockTopic || "").trim();
        node.outAvailTopic = (config.outAvailTopic || "HAVW.2").trim();

        node.needThresholdKw = Math.max(0, Number(config.needThresholdKw ?? 0.1));
        node.compSpeedMinHz = Math.max(0, Number(config.compSpeedMinHz ?? 10));
        node.noEvidenceTimeoutSec = Math.max(10, Number(config.noEvidenceTimeoutSec ?? 600));
        node.recoveryClearSec = Math.max(10, Number(config.recoveryClearSec ?? 180));

        let enableCmd = 0;
        let needHeat = 0;
        let compSpeed = 0;
        let defrost = 0;
        let block = 0;

        let unavailable = 0;
        let noEvidenceSince = null;
        let recoverySince = null;
        let lastAvail = null;

        function b01(v) {
            const n = Number(v);
            return Number.isFinite(n) && n !== 0 ? 1 : 0;
        }
        function sendProblem() {
            if (!node.outAvailTopic) return;
            const problem = unavailable ? 1 : 0;
            if (lastAvail === problem) return;
            lastAvail = problem;
            node.send({ topic: node.outAvailTopic, payload: problem });
        }
        function compute() {
            const now = Date.now();
            const evidence = Number.isFinite(compSpeed) && compSpeed >= node.compSpeedMinHz ? 1 : 0;
            const monitorActive = enableCmd && needHeat && !defrost && !block;

            if (!monitorActive) {
                unavailable = 0;
                noEvidenceSince = null;
                recoverySince = null;
                sendProblem();
                node.status({ fill: "grey", shape: "dot", text: "idle" });
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
            const reason = block ? "block" : defrost ? "defrost" : unavailable ? "no-evidence" : "ok";
            node.status({
                fill: unavailable ? "red" : "green",
                shape: "dot",
                text: `problem=${unavailable ? 1 : 0} reason=${reason} spd=${Number(compSpeed || 0).toFixed(1)}Hz`
            });
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            if (t === node.enableCmdTopic) enableCmd = b01(msg.payload);
            else if (t === node.needHeatTopic) needHeat = Number(msg.payload) > node.needThresholdKw ? 1 : 0;
            else if (t === node.compSpeedTopic) compSpeed = Number(msg.payload);
            else if (t === node.defrostTopic) defrost = b01(msg.payload);
            else if (t === node.blockTopic) block = b01(msg.payload);
            else return;
            compute();
        });
    }

    RED.nodes.registerType("uniflex-hp-watchdog", HpWatchdogNode);
};
