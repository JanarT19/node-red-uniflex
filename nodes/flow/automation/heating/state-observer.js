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
            const x = Number(v);
            return Number.isFinite(x) ? x : null;
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
            if (t === node.roomSpTopic) s.roomSp = n(msg.payload);
            else if (t === node.roomActTopic) s.roomAct = n(msg.payload);
            else if (t === node.flowTopic) s.flow = n(msg.payload);
            else if (t === node.dpTopic) s.dp = n(msg.payload);
            else if (t === node.openFracTopic) s.openFrac = n(msg.payload);
            else if (t === node.tankTempTopic) s.tankTemp = n(msg.payload);
            else if (t === node.returnTempTopic) s.retTemp = n(msg.payload);
            else return;
            emit();
        });
    }

    RED.nodes.registerType("uniflex-state-observer", StateObserverNode);
};
