const ts = require("../../core/lib/timestamp.js");
// monovibrator.js
// Node-RED node: monovibrator (one-shot / monostable)
// Purpose: Output a pulse of configurable length on active input.
// The pulse stops after the configured duration, even if input is repeated or held active.
// After the pulse ends, there's a configurable off-time before it can be triggered again.

module.exports = function (RED) {
    function MonovibratorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.inputTopic = config.inputTopic || "";
        node.outputTopic = config.outputTopic || "";
        node.pulseDurationSec = Number(config.pulseDurationSec ?? 10);
        node.offTimeSec = Number(config.offTimeSec ?? 5);
        node.activeValue = config.activeValue !== undefined ? config.activeValue : 1; // what constitutes "active" input
        node.outputActiveValue = config.outputActiveValue !== undefined ? config.outputActiveValue : 1;
        node.outputInactiveValue = config.outputInactiveValue !== undefined ? config.outputInactiveValue : 0;

        // ---- STATE
        let outputState = false; // true = pulse active, false = idle
        let pulseTimer = null;
        let offTimer = null;
        let inOffTime = false; // true = in off-time period, cannot be triggered
        let lastTriggerTime = null;
        let offTimeStartTime = null; // when off-time started

        function isActiveInput(payload) {
            if ((payload == null)) return false;
            // Check if payload matches active value
            if (payload === node.activeValue) return true;
            if (payload === true && node.activeValue == 1) return true;
            if (payload === "true" && node.activeValue == 1) return true;
            if (Number(payload) === Number(node.activeValue)) return true;
            return false;
        }

        function sendOutput(active) {
            outputState = active;
            const payload = active ? node.outputActiveValue : node.outputInactiveValue;
            const msg = { payload };
            if (node.outputTopic) {
                msg.topic = node.outputTopic;
            }
            node.send(msg);
            updateStatus();
        }

        function updateStatus() {
            if (outputState) {
                const remaining = pulseTimer ? Math.ceil((node.pulseDurationSec * 1000 - (Date.now() - lastTriggerTime)) / 1000) : 0;
                node.status({ fill: "green", shape: "dot", text: `pulse ON (${remaining}s remaining)` });
            } else if (inOffTime) {
                const remaining = offTimeStartTime ? Math.ceil((node.offTimeSec * 1000 - (Date.now() - offTimeStartTime)) / 1000) : 0;
                node.status({ fill: "yellow", shape: "ring", text: `off-time (${remaining}s remaining)` });
            } else {
                node.status({ fill: "grey", shape: "ring", text: "idle" });
            }
        }

        function startPulse() {
            if (outputState || inOffTime) {
                // Already in pulse or in off-time, ignore
                return;
            }

            lastTriggerTime = Date.now();
            sendOutput(true);

            // Schedule end of pulse
            pulseTimer = setTimeout(() => {
                pulseTimer = null;
                sendOutput(false);
                
                // Start off-time
                if (node.offTimeSec > 0) {
                    inOffTime = true;
                    offTimeStartTime = Date.now();
                    updateStatus();
                    
                    // Update status periodically during off-time
                    const offStatusInterval = setInterval(() => {
                        if (inOffTime) {
                            updateStatus();
                        } else {
                            clearInterval(offStatusInterval);
                        }
                    }, 1000);
                    
                    offTimer = setTimeout(() => {
                        offTimer = null;
                        inOffTime = false;
                        offTimeStartTime = null;
                        updateStatus();
                    }, node.offTimeSec * 1000);
                }
            }, node.pulseDurationSec * 1000);

            // Update status periodically during pulse
            const statusInterval = setInterval(() => {
                if (outputState) {
                    updateStatus();
                } else {
                    clearInterval(statusInterval);
                }
            }, 1000);
        }

        // Initialize status
        updateStatus();

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = msg.payload;

            // Check if this message is for us
            if (node.inputTopic && t !== node.inputTopic) {
                return; // Not our topic
            }

            // Check if input is active
            if (isActiveInput(p)) {
                startPulse();
            }
        });

        node.on("close", (done) => {
            if (pulseTimer) {
                clearTimeout(pulseTimer);
                pulseTimer = null;
            }
            if (offTimer) {
                clearTimeout(offTimer);
                offTimer = null;
            }
            node.status({});
            if (done) done();
        });
    }

    RED.nodes.registerType("uniflex-monovibrator", MonovibratorNode);
};
