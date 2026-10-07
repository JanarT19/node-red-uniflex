const ts = require("../../core/lib/timestamp.js");
// roof-vent.js
// Wintergarden roof ventilation: temperature thresholds drive valve and ventilator outputs.
// All values in degrees C; dC conversion is handled by read/write data-stream nodes.

const ROOF_VENT_VERSION = "1.2.0";

module.exports = function (RED) {
    function RoofVentNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const tag = `[roof-vent:${node.name || "unnamed"}]`;

        node.name = config.name || "";

        node.tempTopic = (config.tempTopic || "TAVW.1").trim();

        node.thresholdValveTopic = (config.thresholdValveTopic || "TAVW.2").trim();
        node.thresholdVentTopic = (config.thresholdVentTopic || "TAVW.3").trim();
        node.thresholdVentHighTopic = (config.thresholdVentHighTopic || "TAVW.4").trim();

        node.outVentOnTopic = (config.outVentOnTopic || "TADW.1").trim();
        node.outVentHighTopic = (config.outVentHighTopic || "TADW.2").trim();
        node.outValveOpenTopic = (config.outValveOpenTopic || "TADW.3").trim();

        // Threshold values set in node UI (degrees C). Used for control logic and written to iolayer.
        node.thresholdValveC = Number(config.thresholdValveC ?? 25);
        node.thresholdVentOnC = Number(config.thresholdVentOnC ?? 28);
        node.thresholdVentHighC = Number(config.thresholdVentHighC ?? 32);
        node.hysteresisC = Math.max(0, Number(config.hysteresisC ?? 0.5));

        let tempC = null;
        let valveOpen = false;
        let ventOn = false;
        let ventHigh = false;
        const lastSent = {};
        const THRESHOLD_MATCH_EPS_C = 0.05;

        function isMonotonic() {
            return node.thresholdValveC < node.thresholdVentOnC
                && node.thresholdVentOnC < node.thresholdVentHighC;
        }

        function sendDirect(topic, payload) {
            if (!topic) return;
            node.send({ topic, payload });
        }

        function sendDoChanged(topic, payload, label) {
            if (!topic) return;
            if (lastSent[topic] === payload) return;
            lastSent[topic] = payload;
            node.log(`${tag} DO ${label} -> ${payload}`);
            node.send({ topic, payload });
        }

        function applyHysteresis(currentC, active, onThresholdC) {
            const offThresholdC = onThresholdC - node.hysteresisC;
            if (active) {
                return currentC >= offThresholdC;
            }
            return currentC >= onThresholdC;
        }

        function publishThresholds(reason) {
            sendDirect(node.thresholdValveTopic, node.thresholdValveC);
            sendDirect(node.thresholdVentTopic, node.thresholdVentOnC);
            sendDirect(node.thresholdVentHighTopic, node.thresholdVentHighC);
            if (reason) {
                node.log(
                    `${tag} thresholds written (${reason}): ` +
                    `valve=${node.thresholdValveC.toFixed(1)}C ` +
                    `vent=${node.thresholdVentOnC.toFixed(1)}C ` +
                    `high=${node.thresholdVentHighC.toFixed(1)}C`
                );
            }
        }

        function syncThresholdFromIolayer(topic, valueC, configC, label) {
            if (!Number.isFinite(valueC)) return;
            if (Math.abs(valueC - configC) <= THRESHOLD_MATCH_EPS_C) return;
            node.log(
                `${tag} ${label} iolayer=${valueC.toFixed(1)}C != node=${configC.toFixed(1)}C, overwriting`
            );
            sendDirect(topic, configC);
        }

        function logThresholdCrossing(label, active, thresholdC) {
            if (tempC == null) return;
            if (active) {
                node.log(
                    `${tag} ${label} crossed ON: T=${tempC.toFixed(1)}C >= ${thresholdC.toFixed(1)}C`
                );
            } else {
                const offC = thresholdC - node.hysteresisC;
                node.log(
                    `${tag} ${label} crossed OFF: T=${tempC.toFixed(1)}C < ${offC.toFixed(1)}C`
                );
            }
        }

        function updateStatus() {
            const fill = !isMonotonic() ? "yellow" : (ventHigh || ventOn || valveOpen ? "green" : "blue");
            if (tempC == null) {
                node.status({ fill: "grey", shape: "ring", text: "waiting for temperature" });
                return;
            }
            const warn = !isMonotonic() ? " !order" : "";
            node.status({
                fill,
                shape: "dot",
                text: `${tempC.toFixed(1)}C valve=${valveOpen ? 1 : 0} vent=${ventOn ? 1 : 0} hi=${ventHigh ? 1 : 0}${warn}`
            });
        }

        function computeAndPublish() {
            if (!isMonotonic()) {
                node.warn(
                    `${tag} Thresholds not monotonic: ` +
                    `valve=${node.thresholdValveC} vent=${node.thresholdVentOnC} high=${node.thresholdVentHighC} ` +
                    `(expected valve < vent < high)`
                );
            }

            if (tempC == null) {
                updateStatus();
                return;
            }

            const prevValve = valveOpen;
            const prevVent = ventOn;
            const prevHigh = ventHigh;

            valveOpen = applyHysteresis(tempC, valveOpen, node.thresholdValveC);
            ventOn = applyHysteresis(tempC, ventOn, node.thresholdVentOnC);
            ventHigh = applyHysteresis(tempC, ventHigh, node.thresholdVentHighC);

            if (valveOpen !== prevValve) {
                logThresholdCrossing("valve open", valveOpen, node.thresholdValveC);
            }
            if (ventOn !== prevVent) {
                logThresholdCrossing("ventilator ON", ventOn, node.thresholdVentOnC);
            }
            if (ventHigh !== prevHigh) {
                logThresholdCrossing("ventilator high", ventHigh, node.thresholdVentHighC);
            }

            if (ventHigh) ventOn = true;
            if (ventOn) valveOpen = true;

            sendDoChanged(node.outValveOpenTopic, valveOpen ? 1 : 0, "valve open");
            sendDoChanged(node.outVentOnTopic, ventOn ? 1 : 0, "ventilator ON");
            sendDoChanged(node.outVentHighTopic, ventHigh ? 1 : 0, "ventilator high");
            updateStatus();
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            const n = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));

            if (t === node.tempTopic) {
                if (n === null) return;
                tempC = n;
                computeAndPublish();
                return;
            }

            if (t === node.thresholdValveTopic) {
                syncThresholdFromIolayer(t, n, node.thresholdValveC, "valve threshold");
            } else if (t === node.thresholdVentTopic) {
                syncThresholdFromIolayer(t, n, node.thresholdVentOnC, "vent ON threshold");
            } else if (t === node.thresholdVentHighTopic) {
                syncThresholdFromIolayer(t, n, node.thresholdVentHighC, "vent high threshold");
            }
        });

        if (!isMonotonic()) {
            node.warn(
                `${tag} Deploy: thresholds not monotonic ` +
                `(valve=${node.thresholdValveC} vent=${node.thresholdVentOnC} high=${node.thresholdVentHighC})`
            );
        }

        node.log(`${tag} started v${ROOF_VENT_VERSION}`);
        publishThresholds("deploy");
        updateStatus();

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-roof-vent", RoofVentNode);
};
