const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function CirculationControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.flowTargetTopic = (config.flowTargetTopic || "").trim();
        node.measuredFlowTopic = (config.measuredFlowTopic || "").trim();
        node.openFracTopic = (config.openFracTopic || "").trim();
        node.safeModeTopic = (config.safeModeTopic || "").trim();
        node.testActiveTopic = (config.testActiveTopic || "").trim();
        node.outPumpCmdTopic = (config.outPumpCmdTopic || "").trim();
        node.outFlowErrTopic = (config.outFlowErrTopic || "").trim();

        node.kp = Number(config.kp ?? 20);
        node.ii = Number(config.ii ?? 0.05);
        node.pumpMinPct = Number(config.pumpMinPct ?? 20);
        node.pumpMaxPct = Number(config.pumpMaxPct ?? 100);
        node.safePumpPct = Number(config.safePumpPct ?? 30);
        node.testPumpPct = Number(config.testPumpPct ?? 80);
        node.flowToPctGain = Number(config.flowToPctGain ?? 20);

        let flowTarget = null;
        let measuredFlow = null;
        let openFrac = null;
        let safeMode = 0;
        let testActive = 0;
        let integ = 0;
        let lastTs = Date.now();
        const lastSent = {};

        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }
        function as01(v) {
            const n = Number(v);
            return Number.isFinite(n) && n !== 0 ? 1 : 0;
        }
        function sendChanged(topic, payload) {
            if (!topic) return;
            if (lastSent[topic] === payload) return;
            lastSent[topic] = payload;
            node.send({ topic, payload });
        }

        function compute() {
            let outPct = node.pumpMinPct;

            if (safeMode) {
                outPct = node.safePumpPct;
            } else if (testActive) {
                outPct = node.testPumpPct;
            } else if (flowTarget != null && measuredFlow != null) {
                const now = Date.now();
                const dt = Math.max(0.05, Math.min(5, (now - lastTs) / 1000));
                lastTs = now;
                const err = flowTarget - measuredFlow;
                integ += node.ii * err * dt;
                integ = clamp(integ, -50, 50);
                outPct = node.pumpMinPct + node.kp * err + integ;
                sendChanged(node.outFlowErrTopic, Number(err.toFixed(4)));
            } else if (flowTarget != null) {
                outPct = node.pumpMinPct + node.flowToPctGain * flowTarget;
            }

            if (openFrac != null) {
                const cap = node.pumpMinPct + (node.pumpMaxPct - node.pumpMinPct) * clamp(openFrac, 0, 1);
                outPct = Math.min(outPct, cap);
            }

            outPct = clamp(outPct, node.pumpMinPct, node.pumpMaxPct);
            sendChanged(node.outPumpCmdTopic, Number(outPct.toFixed(2)));
            node.status({
                fill: safeMode ? "red" : testActive ? "yellow" : "blue",
                shape: "dot",
                text: `cmd=${outPct.toFixed(1)}% flowT=${flowTarget ?? "-"} flow=${measuredFlow ?? "-"}`
            });
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            const n = Number(msg.payload);
            if (t === node.flowTargetTopic) flowTarget = Number.isFinite(n) ? n : null;
            else if (t === node.measuredFlowTopic) measuredFlow = Number.isFinite(n) ? n : null;
            else if (t === node.openFracTopic) openFrac = Number.isFinite(n) ? n : null;
            else if (t === node.safeModeTopic) safeMode = as01(msg.payload);
            else if (t === node.testActiveTopic) testActive = as01(msg.payload);
            else return;
            compute();
        });
    }

    RED.nodes.registerType("uniflex-circulation-control", CirculationControlNode);
};
