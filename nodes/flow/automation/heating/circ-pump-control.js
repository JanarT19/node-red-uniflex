const ts = require("../../core/lib/timestamp.js");
// circ-pump-control.js
// Node-RED node: circ-pump-control
// Purpose: Control circulation pump speed from average valve openness (primary)
//          with an optional small proportional temperature-error trim.

const CIRC_PUMP_CONTROL_VERSION = "2.0.0";

module.exports = function (RED) {
    let nodeTypeRegistered = false;

    function CircPumpControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        if (!nodeTypeRegistered) {
            nodeTypeRegistered = true;
            node.log(`[circ-pump-control] Node type registered, version ${CIRC_PUMP_CONTROL_VERSION}`);
        }

        // ---- CONFIG
        node.name = config.name || "";

        // Topics
        node.openFracTopic = (config.openFracTopic || "").trim();
        node.tAvgTopic = (config.tAvgTopic || "").trim();
        node.spAvgTopic = (config.spAvgTopic || "").trim();
        node.coolsTopic = (config.coolsTopic || "").trim();
        node.cpsvTopic = (config.cpsvTopic || "").trim();
        node.testTopic = (config.testTopic || "").trim();

        // Curve: speed = speedMin + (speedMax - speedMin) * openFrac^curveExp
        node.speedMin = Math.max(0, Number(config.speedMin ?? 20));
        node.speedMax = Math.min(100, Number(config.speedMax ?? 100));
        node.curveExp = Math.max(0.1, Number(config.curveExp ?? 1.0));

        // Optional P-only temperature trim: ±trimLimit %
        node.trimGain = Number(config.trimGain ?? 0);
        node.trimLimit = Math.max(0, Number(config.trimLimit ?? 10));

        // Cooling: adds shift to error before inversion
        node.coolShift = Number(config.coolShift ?? 0.5);

        // Global output clamp (always honoured regardless of curve)
        node.lolim = Math.max(0, Number(config.lolim ?? 0));
        node.hilim = Math.min(100, Number(config.hilim ?? 100));

        // Test override
        node.testSpeedPercent = Math.max(0, Math.min(100, Number(config.testSpeedPercent ?? 80)));

        // ---- STATE
        let openFrac = null;
        let tAvg = null;
        let spAvg = null;
        let cools = false;
        let testActive = false;

        // ---- Helpers
        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        // ---- Compute and publish
        function computeAndPublish() {
            if (!node.cpsvTopic) {
                setStatus(`No output topic (${ts.formatStatus()})`, "yellow");
                return;
            }

            // Test override: force pump to configured speed
            if (node.testTopic && testActive) {
                const pct = parseFloat(clamp(node.testSpeedPercent, node.lolim, node.hilim).toFixed(2));
                node.send({ topic: node.cpsvTopic, payload: pct });
                setStatus(`Test: ${pct}% (${ts.formatStatus()})`, "yellow");
                return;
            }

            // Wait for at least openFrac before producing output
            if (openFrac == null) {
                setStatus(`Waiting for openFrac (${ts.formatStatus()})`, "grey");
                return;
            }

            // --- Primary: openFrac curve ---
            const frac = clamp(openFrac, 0, 1);
            const base = node.speedMin + (node.speedMax - node.speedMin) * Math.pow(frac, node.curveExp);

            // --- Optional P-only temperature trim ---
            let trim = 0;
            if (node.trimGain !== 0 && tAvg != null && spAvg != null) {
                let err = Number(spAvg) - Number(tAvg);
                if (cools) {
                    err = -(err + node.coolShift); // invert and shift for cooling
                }
                trim = clamp(node.trimGain * err, -node.trimLimit, node.trimLimit);
            }

            const speed = parseFloat(clamp(base + trim, node.lolim, node.hilim).toFixed(2));
            node.send({ topic: node.cpsvTopic, payload: speed });

            const trimTxt = node.trimGain !== 0 ? ` trim=${trim >= 0 ? "+" : ""}${trim.toFixed(1)}%` : "";
            setStatus(`${speed}% (open=${(frac * 100).toFixed(0)}%${trimTxt}) ${ts.formatStatus()}`, "green");
            node.debug(`[circ-pump:${node.name}] open=${(frac * 100).toFixed(0)}% base=${base.toFixed(1)} trim=${trim.toFixed(1)} speed=${speed}%`);
        }

        // ---- Input handler
        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            const n = Number(msg.payload);

            if (node.openFracTopic && t === node.openFracTopic) {
                openFrac = Number.isFinite(n) ? n / 100 : null; // HVAVV arrives as 0..100 %
            } else if (node.tAvgTopic && t === node.tAvgTopic) {
                tAvg = Number.isFinite(n) ? n : null;
            } else if (node.spAvgTopic && t === node.spAvgTopic) {
                spAvg = Number.isFinite(n) ? n : null;
            } else if (node.coolsTopic && t === node.coolsTopic) {
                cools = !!Number(msg.payload);
            } else if (node.testTopic && t === node.testTopic) {
                testActive = !!Number(msg.payload);
            } else {
                return;
            }

            computeAndPublish();
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-circ-pump-control", CircPumpControlNode);
};
