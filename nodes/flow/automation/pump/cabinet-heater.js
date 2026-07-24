const ts = require("../../core/lib/timestamp.js");
// uniflex-cabinet-heater.js
// Node-RED node: uniflex-cabinet-heater
// Purpose: Simple on/off heater control with hysteresis for cabinet heating.

module.exports = function (RED) {
    function CabinetHeaterNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.tempActualTopic = config.tempActualTopic || ""; // T2W.1 - actual temperature
        node.tempSetpointTopic = config.tempSetpointTopic || ""; // T2W.2 - setpoint
        node.heaterRelayTopic = config.heaterRelayTopic || ""; // HRS.1 - heater relay output
        node.hysteresis = Number(config.hysteresis ?? 0.5); // Hysteresis in °C

        // Validate hysteresis
        if (node.hysteresis < 0.1 || node.hysteresis > 10.0) {
            node.warn(`Hysteresis out of range (0.1-10.0°C), using default 0.5°C`);
            node.hysteresis = 0.5;
        }

        // ---- STATE
        let tempActual = null; // Actual temperature (°C)
        let tempSetpoint = null; // Setpoint temperature (°C)
        let heaterState = 0; // 0=OFF, 1=ON

        function updateStatus() {
            let parts = [];

            // Heater state
            if (heaterState === 1) {
                parts.push("ON");
            } else {
                parts.push("OFF");
            }

            // Temperature info
            if (tempActual !== null) {
                parts.push(`T=${tempActual.toFixed(1)}°C`);
            }
            if (tempSetpoint !== null) {
                parts.push(`SP=${tempSetpoint.toFixed(1)}°C`);
            }

            const statusText = parts.join(" ");

            // Determine color
            let fill = "grey";
            if (heaterState === 1) {
                fill = "orange"; // Heating active
            } else if (tempActual !== null && tempSetpoint !== null && tempActual < tempSetpoint - node.hysteresis) {
                fill = "blue"; // Below setpoint
            } else {
                fill = "green"; // At or above setpoint
            }

            node.status({ fill, shape: "dot", text: statusText });
        }

        updateStatus();

        // ---- HEATER CONTROL LOGIC
        function checkHeaterControl() {
            if (tempActual === null || tempSetpoint === null) {
                updateStatus();
                return;
            }

            const tempDiff = tempActual - tempSetpoint;
            const newHeaterState = tempDiff < -node.hysteresis ? 1 : tempDiff > node.hysteresis ? 0 : heaterState;

            if (newHeaterState !== heaterState) {
                heaterState = newHeaterState;

                if (heaterState === 1) {
                    node.log(`Heater ON: temp ${tempActual.toFixed(1)}°C < setpoint ${tempSetpoint.toFixed(1)}°C - ${node.hysteresis.toFixed(1)}°C`);
                } else {
                    node.log(`Heater OFF: temp ${tempActual.toFixed(1)}°C > setpoint ${tempSetpoint.toFixed(1)}°C + ${node.hysteresis.toFixed(1)}°C`);
                }

                sendHeaterCmd(heaterState);
            }

            updateStatus();
        }

        function sendHeaterCmd(value) {
            if (!node.heaterRelayTopic) {
                node.warn("Heater relay topic not configured");
                return;
            }
            node.send({ topic: node.heaterRelayTopic, payload: value });
        }

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = msg.payload;

            // Actual temperature (AI)
            if (t === node.tempActualTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                tempActual = Number(val);
                checkHeaterControl();
                return;
            }

            // Setpoint temperature (from iolayer)
            if (t === node.tempSetpointTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const newSetpoint = Number(val);
                // Only log if value actually changed
                if (tempSetpoint === null || Math.abs(tempSetpoint - newSetpoint) > 0.1) {
                    tempSetpoint = newSetpoint;
                    node.log(`Setpoint updated: ${tempSetpoint.toFixed(1)}°C`);
                } else {
                    tempSetpoint = newSetpoint; // Update even if same (for consistency)
                }
                checkHeaterControl();
                return;
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-cabinet-heater", CabinetHeaterNode);
};
