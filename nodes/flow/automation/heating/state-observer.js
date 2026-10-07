const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function StateObserverNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.roomSpTopic = (config.roomSpTopic || "").trim();
        node.roomActTopic = (config.roomActTopic || "").trim();
        node.flowTopic = (config.flowTopic || "").trim();
        node.dpTopic = (config.dpTopic || "").trim();
        node.openFracTopic = (config.openFracTopic || "").trim();
        node.tankTempTopic = (config.tankTempTopic || "").trim();
        node.returnTempTopic = (config.returnTempTopic || "").trim();
        node.outTopic = (config.outTopic || "").trim();

        const s = {
            roomSp: null,
            roomAct: null,
            flow: null,
            dp: null,
            openFrac: null,
            tankTemp: null,
            retTemp: null
        };

        function n(v) {
            return (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
        }

        function emit() {
            const roomErr = s.roomSp != null && s.roomAct != null ? s.roomSp - s.roomAct : 0;
            const qProxy = s.flow != null && s.tankTemp != null && s.retTemp != null ? Math.max(0, s.flow * (s.tankTemp - s.retTemp)) : null;
            const payload = {
                roomErr,
                flow: s.flow,
                dp: s.dp,
                openFrac: s.openFrac,
                tankTemp: s.tankTemp,
                retTemp: s.retTemp,
                qProxy,
                ts: Date.now()
            };
            node.send({ topic: node.outTopic || "state/observer", payload });
            node.status({ fill: "blue", shape: "dot", text: `err=${roomErr.toFixed(2)} flow=${s.flow ?? "-"} open=${s.openFrac ?? "-"}` });
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            if (t === node.roomSpTopic) {
                const v = n(msg.payload);
                if (v === null) return;
                s.roomSp = v;
            } else if (t === node.roomActTopic) {
                const v = n(msg.payload);
                if (v === null) return;
                s.roomAct = v;
            } else if (t === node.flowTopic) {
                const v = n(msg.payload);
                if (v === null) return;
                s.flow = v;
            } else if (t === node.dpTopic) {
                const v = n(msg.payload);
                if (v === null) return;
                s.dp = v;
            } else if (t === node.openFracTopic) {
                const v = n(msg.payload);
                if (v === null) return;
                s.openFrac = v;
            } else if (t === node.tankTempTopic) {
                const v = n(msg.payload);
                if (v === null) return;
                s.tankTemp = v;
            } else if (t === node.returnTempTopic) {
                const v = n(msg.payload);
                if (v === null) return;
                s.retTemp = v;
            } else return;
            emit();
        });
    }

    RED.nodes.registerType("uniflex-state-observer", StateObserverNode);
};
