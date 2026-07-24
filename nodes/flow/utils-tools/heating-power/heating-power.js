const ts = require("../../core/lib/timestamp.js");
// uniflex-heating-power.js
// Computes hydronic heating power: Q = flow x (T_supply - T_return) x K
// Mirrors the Python waterpower() calculation in the iolayer.

module.exports = function (RED) {
    function HeatingPowerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Strip autocomplete label suffix: "THW.1: Description..." -> "THW.1"
        function extractTopic(raw) {
            return (raw || "").trim().split(":")[0].trim();
        }

        const supplyTopic = extractTopic(config.supplyTopic);
        const returnTopic = extractTopic(config.returnTopic);
        const flowTopic = extractTopic(config.flowTopic);
        const outputTopic = extractTopic(config.outputTopic);
        const inputTimeout = parseInt(config.inputTimeout, 10) || 120; // seconds
        const flowUnit = config.flowUnit || "m3h"; // m3h | Lh | Lmin
        const outputUnit = config.outputUnit || "kW"; // kW | W
        const cp = parseFloat(config.cp) || 4186; // J/(kg*K)
        const rho = parseFloat(config.rho) || 1000; // kg/m3
        const enableLog = config.enableLog === true;

        // Q[kW] = flow[m3/h] x dT[C] x rho[kg/m3] x cp[J/(kg*K)] / 3600[s/h] / 1000[W->kW]
        const flowFactor =
            flowUnit === "Lh"
                ? 1 / 1000 // L/h -> m3/h
                : flowUnit === "Lmin"
                  ? 60 / 1000 // L/min -> m3/h
                  : 1.0; // m3/h (default)

        const outputFactor = outputUnit === "W" ? 1 : 1 / 1000; // W or kW
        const flowLabel = flowUnit === "m3h" ? "m3/h" : flowUnit === "Lh" ? "L/h" : "L/min";

        const K = ((rho * cp) / 3600) * flowFactor * outputFactor;

        const requiredTopics = [supplyTopic, returnTopic, flowTopic].filter(Boolean);
        const cache = {}; // topic -> { value, ts }

        function log(msg) {
            if (enableLog) node.warn(`[heating-power:${node.name}] ${msg}`);
        }

        function isStale(entry) {
            return !entry || Date.now() - entry.ts > inputTimeout * 1000;
        }

        function tryCompute() {
            for (const t of requiredTopics) {
                if (isStale(cache[t])) return;
                if (cache[t].value == null || isNaN(cache[t].value)) return;
            }

            const Ts = cache[supplyTopic].value;
            const Tr = cache[returnTopic].value;
            const F = cache[flowTopic].value;

            if (F < 0) {
                node.status({ fill: "yellow", shape: "ring", text: "flow negative" });
                log(`flow negative: ${F}`);
                return;
            }

            const dT = Ts - Tr;
            const Q = parseFloat((F * dT * K).toFixed(3));

            log(`Ts=${Ts} Tr=${Tr} dT=${dT.toFixed(2)} F=${F} -> Q=${Q} ${outputUnit}`);

            if (outputTopic) {
                node.send({ topic: outputTopic, payload: Q });
            }
            node.status({
                fill: dT >= 0 ? "green" : "yellow",
                shape: "dot",
                text: `Q=${Q.toFixed(2)} ${outputUnit}  dT=${dT.toFixed(1)}C  F=${F.toFixed(3)} ${flowLabel}`
            });
        }

        // Show "waiting for input" on startup
        node.status({ fill: "grey", shape: "ring", text: "waiting for input" });

        node.on("input", function (msg) {
            const t = msg.topic;
            if (!requiredTopics.includes(t)) return;
            const v = parseFloat(msg.payload);
            if (!isNaN(v)) {
                cache[t] = { value: v, ts: Date.now() };
                tryCompute();
                // Show which inputs are still missing
                const missing = requiredTopics.filter((rt) => isStale(cache[rt]));
                if (missing.length > 0) {
                    node.status({ fill: "grey", shape: "ring", text: "waiting: " + missing.join(", ") });
                }
            }
        });

        node.on("close", function () {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-heating-power", HeatingPowerNode);
};
