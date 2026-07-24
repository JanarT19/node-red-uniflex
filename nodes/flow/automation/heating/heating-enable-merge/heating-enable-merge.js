const ts = require("../../../core/lib/timestamp.js");
// heating-enable-merge.js
// Node-RED node: uniflex-heating-enable-merge
// Purpose: Merge schedule enable (hp, gas, cooling) with emergency HEW datastream; output effective 0/1 per source.
// Gas and cooling are mutually exclusive at write time (HEW); safety: if both effective, prefer gas.

module.exports = function (RED) {
    function HeatingEnableMergeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.scheduleEnableTopic = (config.scheduleEnableTopic || "").trim();
        node.scheduleHpTopic = (config.scheduleHpTopic || "").trim();
        node.scheduleGasTopic = (config.scheduleGasTopic || "").trim();
        node.hewTopic1 = (config.hewTopic1 || "").trim();
        node.hewTopic2 = (config.hewTopic2 || "").trim();
        node.hewTopic3 = (config.hewTopic3 || "").trim();
        node.autoHpTopic = (config.autoHpTopic || "").trim();
        node.autoGasTopic = (config.autoGasTopic || "").trim();
        node.manualForceHpTopic = (config.manualForceHpTopic || "").trim();
        node.manualForceGasTopic = (config.manualForceGasTopic || "").trim();
        node.manualBlockHpTopic = (config.manualBlockHpTopic || "").trim();
        node.manualBlockGasTopic = (config.manualBlockGasTopic || "").trim();
        node.outTopicGas = (config.outTopicGas || "").trim();
        node.outTopicGasRequest = (config.outTopicGasRequest || "").trim();
        node.outTopicHp = (config.outTopicHp || "").trim();
        node.outTopicCooling = (config.outTopicCooling || "").trim();

        // State: schedule hp, gas (2 members only; no schedule cooling). Emergency hew1, hew2, hew3.
        let scheduleHp = 0,
            scheduleGas = 0;
        let hew1 = 0,
            hew2 = 0,
            hew3 = 0;
        let autoHp = 1,
            autoGas = 1;
        let manualForceHp = 0,
            manualForceGas = 0;
        let manualBlockHp = 0,
            manualBlockGas = 0;
        let lastOutGas = null,
            lastOutGasRequest = null,
            lastOutHp = null,
            lastOutCooling = null;

        function asBool(v) {
            if (v === null || v === undefined) return false;
            const n = Number(v);
            return Number.isFinite(n) && n !== 0;
        }

        function parseSchedulePayload(payload) {
            if (Array.isArray(payload) && payload.length >= 2) {
                return { hp: asBool(payload[0]), gas: asBool(payload[1]) };
            }
            if (payload && typeof payload === "object") {
                const h = payload[".1"] ?? payload.hp ?? payload[0];
                const g = payload[".2"] ?? payload.gas ?? payload[1];
                return { hp: asBool(h), gas: asBool(g) };
            }
            return null;
        }

        function computeAndSend() {
            const baseHp = scheduleHp || hew1;
            const baseGas = scheduleGas || hew2;
            // Priority per channel: manual force > manual block > auto-selected demand
            const effHp = manualForceHp || (baseHp && autoHp && !manualBlockHp);
            let effGas = manualForceGas || (baseGas && autoGas && !manualBlockGas);
            let effCooling = hew3; // no schedule cooling; emergency only
            // Safety: gas and cooling must not both be 1; prefer gas
            if (effGas && effCooling) effCooling = 0;

            const outGas = effGas ? 1 : 0;
            const outHp = effHp ? 1 : 0;
            const outCooling = effCooling ? 1 : 0;

            const msgs = [];
            if (node.outTopicGas && lastOutGas !== outGas) {
                msgs.push({ topic: node.outTopicGas, payload: outGas });
                lastOutGas = outGas;
            }
            if (node.outTopicGasRequest && lastOutGasRequest !== outGas) {
                msgs.push({ topic: node.outTopicGasRequest, payload: outGas });
                lastOutGasRequest = outGas;
            }
            if (node.outTopicHp && lastOutHp !== outHp) {
                msgs.push({ topic: node.outTopicHp, payload: outHp });
                lastOutHp = outHp;
            }
            if (node.outTopicCooling && lastOutCooling !== outCooling) {
                msgs.push({ topic: node.outTopicCooling, payload: outCooling });
                lastOutCooling = outCooling;
            }
            if (msgs.length) {
                msgs.forEach((m) => node.send(m));
            }

            const gasT = node.outTopicGas ? `${outGas}` : "-";
            const hpT = node.outTopicHp ? `${outHp}` : "-";
            const coolT = node.outTopicCooling ? `${outCooling}` : "-";
            node.status({ fill: "blue", shape: "dot", text: `gas=${gasT} hp=${hpT} cool=${coolT}` });
        }

        node.on("input", function (msg) {
            const topic = String(msg.topic || "").trim();
            // Single-message schedule (e.g. from mpc-house outScheduleEnableTopic)
            if (topic === node.scheduleEnableTopic) {
                const s = parseSchedulePayload(msg.payload);
                if (s) {
                    scheduleHp = s.hp ? 1 : 0;
                    scheduleGas = s.gas ? 1 : 0;
                    computeAndSend();
                }
                return;
            }
            // Separate schedule topics (2 members: hp_ena, gas_ena from cal2datastream)
            const v = msg.payload;
            const n = Number(v);
            const val = Number.isFinite(n) ? (n !== 0 ? 1 : 0) : null;
            if (topic === node.scheduleHpTopic && val !== null) {
                scheduleHp = val;
                computeAndSend();
                return;
            }
            if (topic === node.scheduleGasTopic && val !== null) {
                scheduleGas = val;
                computeAndSend();
                return;
            }
            if (topic === node.hewTopic1) {
                hew1 = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.hewTopic2) {
                hew2 = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.hewTopic3) {
                hew3 = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.autoHpTopic) {
                autoHp = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.autoGasTopic) {
                autoGas = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.manualForceHpTopic) {
                manualForceHp = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.manualForceGasTopic) {
                manualForceGas = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.manualBlockHpTopic) {
                manualBlockHp = val !== null ? val : 0;
                computeAndSend();
                return;
            }
            if (topic === node.manualBlockGasTopic) {
                manualBlockGas = val !== null ? val : 0;
                computeAndSend();
                return;
            }
        });

        node.status({ fill: "grey", shape: "dot", text: "no data" });
    }

    RED.nodes.registerType("uniflex-heating-enable-merge", HeatingEnableMergeNode);
};
