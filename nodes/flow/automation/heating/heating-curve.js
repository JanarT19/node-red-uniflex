const ts = require("../../core/lib/timestamp.js");
// heating-curve.js
// Node-RED node: heating-curve
// Purpose: Linear interpolation from input to output; two values define input range, two values define output range. Output clamped to configured range.

module.exports = function (RED) {
    function HeatingCurveNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.inputTopic = config.inputTopic || "";
        node.outputTopic = config.outputTopic || "";
        node.inputLow = Number(config.inputLow ?? -15);
        node.inputHigh = Number(config.inputHigh ?? 15);
        node.outputLow = Number(config.outputLow ?? 25);
        node.outputHigh = Number(config.outputHigh ?? 55);
        node.outputInt = config.outputInt === true;

        // ---- STATE
        let inputValue = null;

        function interpolate(input) {
            const inLo = node.inputLow;
            const inHi = node.inputHigh;
            const outLo = node.outputLow;
            const outHi = node.outputHigh;
            if (inHi === inLo) {
                return (outLo + outHi) / 2;
            }
            const t = (Number(input) - inLo) / (inHi - inLo);
            let out = outLo + t * (outHi - outLo);
            out = Math.max(outLo, Math.min(outHi, out));
            return out;
        }

        function updateStatus() {
            const outLo = node.outputLow;
            const outHi = node.outputHigh;
            if (inputValue === null) {
                node.status({ fill: "grey", shape: "dot", text: "in: -- out: --" });
                return;
            }
            const out = interpolate(inputValue);
            const inStr = typeof inputValue === "number" ? inputValue.toFixed(2) : String(inputValue);
            const outNum = typeof out === "number" ? out : Number(out);
            const outStr = node.outputInt ? String(Math.round(outNum)) : typeof out === "number" ? out.toFixed(2) : String(out);
            const onLimit = out <= outLo || out >= outHi;
            node.status({
                fill: onLimit ? "yellow" : "green",
                shape: "dot",
                text: `in: ${inStr} out: ${outStr}`
            });
        }

        updateStatus();

        node.on("input", function (msg) {
            const t = msg.topic || "";
            if (t !== node.inputTopic) {
                return;
            }
            let val = msg.payload;
            if (Array.isArray(val) && val.length > 0) {
                val = val[0];
            }
            val = Number(val);
            if (isNaN(val)) {
                return;
            }
            inputValue = val;
            const output = interpolate(val);
            const payload = node.outputInt ? Math.round(Number(output)) : parseFloat(Number(output).toFixed(2));
            node.send({
                topic: node.outputTopic,
                payload: payload
            });
            updateStatus();
        });

        node.on("close", function () {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-heating-curve", HeatingCurveNode);
};
