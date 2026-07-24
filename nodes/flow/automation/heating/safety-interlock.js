const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function SafetyInterlockNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.eStopTopic = (config.eStopTopic || "").trim();
        node.hpFaultTopic = (config.hpFaultTopic || "").trim();
        node.gasFaultTopic = (config.gasFaultTopic || "").trim();
        node.blockHpOutTopic = (config.blockHpOutTopic || "").trim();
        node.blockGasOutTopic = (config.blockGasOutTopic || "").trim();
        node.pumpSafeOutTopic = (config.pumpSafeOutTopic || "").trim();
        node.floorSafeOutTopic = (config.floorSafeOutTopic || "").trim();
        node.pumpSafeValue = Number(config.pumpSafeValue ?? 20);
        node.floorSafeValue = Number(config.floorSafeValue ?? 1);

        const s = { eStop: 0, hpFault: 0, gasFault: 0, blocked: null };

        function b01(v) {
            const n = Number(v);
            return Number.isFinite(n) && n !== 0 ? 1 : 0;
        }
        function emit(topic, payload) {
            if (!topic) return;
            node.send({ topic, payload });
        }
        function compute() {
            const blocked = s.eStop || s.hpFault || s.gasFault ? 1 : 0;
            if (s.blocked === blocked) return;
            s.blocked = blocked;
            emit(node.blockHpOutTopic, blocked);
            emit(node.blockGasOutTopic, blocked);
            emit(node.pumpSafeOutTopic, blocked ? node.pumpSafeValue : 0);
            emit(node.floorSafeOutTopic, blocked ? node.floorSafeValue : 0);
            node.status({ fill: blocked ? "red" : "green", shape: "dot", text: blocked ? "INTERLOCK ACTIVE" : "OK" });
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            if (t === node.eStopTopic) s.eStop = b01(msg.payload);
            else if (t === node.hpFaultTopic) s.hpFault = b01(msg.payload);
            else if (t === node.gasFaultTopic) s.gasFault = b01(msg.payload);
            else return;
            compute();
        });
    }

    RED.nodes.registerType("uniflex-safety-interlock", SafetyInterlockNode);
};
