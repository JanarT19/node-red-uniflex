const ts = require("../../../core/lib/timestamp.js");
// heater-setpoint-clamp.js
// Node-RED node: uniflex-heater-setpoint-clamp
// Purpose: Generate heater outflow setpoint with an internal PI from average room temperature error.
// A secondary "clamp PI" smoothly controls the effective high limit based on tank/flow overshoot.
// This prevents oscillation by avoiding discrete corrections.

module.exports = function (RED) {
    function HeaterSetpointClampNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.errorTopic = config.errorTopic || ""; // average room temperature error (PI input)
        node.tankTopic = config.tankTopic || "";
        node.flowFromTankTopic = config.flowFromTankTopic || "";
        node.flowRateTopic = config.flowRateTopic || ""; // flow rate for feedforward (m³/h)
        node.dhwActiveTopic = config.dhwActiveTopic || ""; // DHW active (1 = freeze heating setpoint)
        node.outputTopic = config.outputTopic || "";

        node.tankFlowLimit = Number(config.tankFlowLimit ?? 40);
        node.heaterLimit = Number(config.heaterLimit ?? 50);
        node.minSetpoint = Number(config.minSetpoint ?? 25);
        node.feedforwardGain = Number(config.feedforwardGain ?? 1);
        node.feedforwardBaseFlow = Number(config.feedforwardBaseFlow ?? 0.35); // flow below this = no boost
        node.outputInt = config.outputInt === true;

        // Main PI parameters
        node.Kp = Number(config.Kp ?? 1);
        node.Ii = Number(config.Ii ?? 0.1);
        node.refSampleSec = Number(config.refSampleSec ?? 60) || 60;
        node.persistencePath = (config.persistencePath || "").trim() || null;

        // Clamp PI parameters (controls effective high limit)
        node.clampKp = Number(config.clampKp ?? 2);
        node.clampIi = Number(config.clampIi ?? 0.03);

        // ---- STATE
        const lastValues = {}; // topic -> number (tank, flow; error not stored here, used immediately)
        let lastSetpoint = null; // last sent setpoint value, shown in status at all times
        let persistenceLoaded = false; // true only if persistence file existed and was read successfully on startup
        let lastLogTime = 0; // for periodic logging
        let dhwActive = false; // true when DHW production is active (freeze all setpoint changes)

        // Clamp PI state (simple implementation - no persistence needed)
        let clampIntegral = 0; // starts at 0, meaning effectiveH = heaterLimit initially
        let lastClampTime = null;
        let lastLoggedEffectiveH = null; // for reducing log verbosity

        function getExpectedTopics() {
            return [node.errorTopic, node.tankTopic, node.flowFromTankTopic, node.flowRateTopic, node.dhwActiveTopic].filter((t) => t && t.length > 0);
        }

        function hasTankOrFlow() {
            const tank = lastValues[node.tankTopic];
            const flow = lastValues[node.flowFromTankTopic];
            const hasValidTank = typeof tank === "number" && !isNaN(tank);
            const hasValidFlow = typeof flow === "number" && !isNaN(flow);
            return hasValidTank || hasValidFlow;
        }

        function getFlowRate() {
            if (!node.flowRateTopic || !(node.flowRateTopic in lastValues)) return 0;
            const rate = lastValues[node.flowRateTopic];
            return typeof rate === "number" && !isNaN(rate) ? Math.max(0, rate) : 0;
        }

        /**
         * Get hottest temperature (max of tank, flow).
         * Uses whichever is available; returns null only if both are missing.
         */
        function getHottest() {
            const tank = lastValues[node.tankTopic];
            const flow = lastValues[node.flowFromTankTopic];
            if (tank == null && flow == null) return null;
            if (tank == null) return flow;
            if (flow == null) return tank;
            return Math.max(tank, flow);
        }

        // Helper for logging: get tank and flow values
        function getTankFlowValues() {
            return {
                tank: lastValues[node.tankTopic],
                flow: lastValues[node.flowFromTankTopic],
                limit: node.tankFlowLimit
            };
        }

        /**
         * Clamp PI: controls the effective high limit based on overshoot
         * Error = hottest - tankFlowLimit (positive = overshoot, negative = headroom)
         * Output = reduction from heaterLimit (0 = no reduction, positive = reduce effectiveH)
         * Returns effectiveH (the dynamic high limit)
         */
        function runClampPI() {
            const hottest = getHottest();
            if (hottest == null) return node.heaterLimit;

            const now = Date.now() / 1000;
            const clampError = hottest - node.tankFlowLimit; // positive = overshoot

            // Calculate dt (time since last update)
            let dt = node.refSampleSec; // default to reference sample
            if (lastClampTime !== null) {
                dt = Math.max(0.1, Math.min(300, now - lastClampTime)); // clamp dt to [0.1s, 5min]
            }
            lastClampTime = now;

            // PI calculation
            // P term: immediate response to overshoot
            const pTerm = node.clampKp * clampError;

            // I term: accumulates over time, scaled by dt relative to reference sample
            // Ii is gain per refSampleSec, so actual gain = Ii * (dt / refSampleSec)
            const iGain = node.clampIi * (dt / node.refSampleSec);
            clampIntegral += clampError * iGain;

            // Clamp integral to valid range [0, H - minSetpoint]
            const maxReduction = node.heaterLimit - node.minSetpoint;
            clampIntegral = Math.max(0, Math.min(maxReduction, clampIntegral));

            // Total output: P + I (both contribute to reduction)
            let clampOutput = pTerm + clampIntegral;

            // Clamp output to valid range
            clampOutput = Math.max(0, Math.min(maxReduction, clampOutput));

            // Effective high limit
            const effectiveH = node.heaterLimit - clampOutput;

            return effectiveH;
        }

        /**
         * Get current clamp reduction (for status/logging)
         */
        function getClampReduction() {
            const hottest = getHottest();
            if (hottest == null) return 0;
            const clampError = hottest - node.tankFlowLimit;
            const pTerm = node.clampKp * clampError;
            const maxReduction = node.heaterLimit - node.minSetpoint;
            return Math.max(0, Math.min(maxReduction, pTerm + clampIntegral));
        }

        // Feedforward: effectiveFlow × max(0, limit - flowTemp) × gain
        // No more suppression after overshoot - the clamp PI handles it smoothly
        function calculateFeedforward() {
            if (!node.flowRateTopic || node.feedforwardGain === 0) return 0;

            const flowRate = getFlowRate();
            const effectiveFlow = flowRate - node.feedforwardBaseFlow;
            if (effectiveFlow <= 0) return 0;
            const flowTemp = lastValues[node.flowFromTankTopic];
            if (flowTemp == null || isNaN(flowTemp)) return 0;
            const deviation = node.tankFlowLimit - flowTemp;
            if (deviation <= 0) return 0;
            return effectiveFlow * deviation * node.feedforwardGain;
        }

        function parsePayload(payload) {
            if (payload == null) return NaN;
            if (Array.isArray(payload) && payload.length > 0) payload = payload[0];
            return Number(payload);
        }

        function updateStatus(text, fill) {
            node.status({ fill: fill || "grey", shape: "dot", text: text || "" });
        }

        function getDefaultSetpoint() {
            return (node.minSetpoint + node.heaterLimit) / 2;
        }

        function statusSetpoint(setpoint, clampReduction, effectiveH, overshoot, warningText) {
            if (warningText) {
                updateStatus(warningText, "yellow");
                return;
            }
            const value = setpoint != null && typeof setpoint === "number" && !isNaN(setpoint) ? setpoint : getDefaultSetpoint();
            if (value != null && typeof value === "number" && !isNaN(value)) {
                const s = node.outputInt ? String(Math.round(value)) : value.toFixed(1);
                let t;
                if (overshoot != null && overshoot > 0.1 && effectiveH != null) {
                    // Show overshoot and effective limit when clamping
                    t = `${s}°C (max ${effectiveH.toFixed(0)}, +${overshoot.toFixed(1)}° over)`;
                } else {
                    t = `${s}°C`;
                }
                updateStatus(t, clampReduction != null && clampReduction > 0.1 ? "yellow" : "green");
            } else {
                updateStatus("setpoint: --", "grey");
            }
        }

        // ---- Main PI init
        (function initPI() {
            try {
                const { createPI } = require("../pi-core");
                const pi = createPI({
                    Kp: node.Kp,
                    Ii: node.Ii,
                    invert: true, // error = actual−setpoint: positive (too warm) → PI decreases; negative (too cold) → PI increases
                    outClampLow: node.minSetpoint,
                    outClampHigh: node.heaterLimit,
                    refSampleSec: node.refSampleSec
                });
                if (!pi || typeof pi.step !== "function") {
                    node.warn("PI core not available");
                    node._pi = null;
                    return;
                }
                node._pi = pi;
                if (node.persistencePath && typeof node._pi.setPersistenceFile === "function") {
                    const pPath = node.persistencePath.trim();
                    const endsWithJson = pPath.endsWith(".json");
                    let filePath;
                    if (endsWithJson) {
                        filePath = pPath;
                    } else {
                        const _pfx = "heater-setpoint-clamp";
                        const _safe = (node.name || node.id).replace(/\s+/g, "-");
                        const _stem = _safe === _pfx || _safe.startsWith(_pfx + "-") ? _safe : `${_pfx}-${_safe}`;
                        filePath = pPath.replace(/\/?$/, "") + "/" + _stem + ".json";
                    }
                    node.debug("[heater-setpoint-clamp] persistencePath='" + pPath + "' endsWithJson=" + endsWithJson + " filePath='" + filePath + "'");
                    node._pi.setPersistenceFile(filePath);
                }
                if (typeof node._pi.setPersistenceMode === "function") {
                    node._pi.setPersistenceMode("external");
                }
                if (typeof node._pi.loadState === "function") {
                    persistenceLoaded = node._pi.loadState();
                    if (persistenceLoaded) node.debug("PI state loaded from persistence");
                }
            } catch (e) {
                node.error("PI init failed: " + e.message);
                node._pi = null;
            }
        })();

        // Send initial setpoint on startup
        (function sendInitialSetpoint() {
            const minSp = node.minSetpoint;
            const H = node.heaterLimit;
            let initial;
            if (node._pi && persistenceLoaded) {
                try {
                    const u = node._pi.step(0, { now: Date.now() / 1000 });
                    initial = Math.max(minSp, Math.min(H, u));
                } catch (e) {
                    initial = getDefaultSetpoint();
                }
            } else {
                initial = getDefaultSetpoint();
            }
            lastSetpoint = node.outputInt ? Math.round(initial) : initial;
            const payload = node.outputInt ? Math.round(initial) : initial;
            const outTopic = node.outputTopic || node.errorTopic;
            if (outTopic) {
                node.send({ topic: outTopic, payload: payload });
            }
            statusSetpoint(lastSetpoint, 0, null, null, null);
        })();

        node.on("input", (msg) => {
            const t = msg.topic || "";
            const topics = getExpectedTopics();
            if (!topics.includes(t)) return;

            const val = parsePayload(msg.payload);
            if (isNaN(val)) {
                node.warn("Invalid number from topic " + t + ": " + JSON.stringify(msg.payload));
                return;
            }

            // Flow rate: just store for feedforward calculation
            if (t === node.flowRateTopic) {
                lastValues[t] = val;
                const reduction = getClampReduction();
                const hottest = getHottest();
                const overshoot = hottest != null ? Math.max(0, hottest - node.tankFlowLimit) : 0;
                statusSetpoint(lastSetpoint, reduction, node.heaterLimit - reduction, overshoot, null);
                return;
            }

            // DHW active: freeze all setpoint changes while active
            if (t === node.dhwActiveTopic) {
                const wasActive = dhwActive;
                dhwActive = val === 1 || val === true || val === "1" || val === "true";
                if (dhwActive !== wasActive) {
                    if (dhwActive) {
                        node.warn("[DHW] active - freezing heating setpoint");
                    } else {
                        node.warn("[DHW] ended - resuming heating control");
                    }
                }
                statusSetpoint(lastSetpoint, 0, null, null, dhwActive ? "DHW active (frozen)" : null);
                return;
            }

            // Skip all processing if DHW is active
            if (dhwActive) {
                return;
            }

            // Tank / flow temp: store and run clamp PI (but don't send output - wait for error topic)
            if (t === node.tankTopic || t === node.flowFromTankTopic) {
                lastValues[t] = val;

                // Run clamp PI to update its state
                const effectiveH = runClampPI();
                const clampReduction = node.heaterLimit - effectiveH;

                const tfv = getTankFlowValues();
                const hottest = getHottest();
                const overshoot = hottest != null ? Math.max(0, hottest - node.tankFlowLimit) : 0;

                // Log only when effectiveH changes significantly (>1°C change)
                const effectiveHChanged = lastLoggedEffectiveH === null || Math.abs(effectiveH - lastLoggedEffectiveH) > 1;
                if (clampReduction > 0.5 && effectiveHChanged) {
                    node.warn(
                        `[clamp] hottest=${hottest?.toFixed(1)} overshoot=${overshoot.toFixed(1)} → ` +
                            `effectiveH=${effectiveH.toFixed(1)} (Kp×err=${(node.clampKp * overshoot).toFixed(1)}, int=${clampIntegral.toFixed(2)})`
                    );
                    lastLoggedEffectiveH = effectiveH;
                }

                statusSetpoint(lastSetpoint, clampReduction, effectiveH, overshoot);
                return;
            }

            // Error topic: run main PI and output
            if (t !== node.errorTopic) return;

            if (!node._pi) {
                statusSetpoint(lastSetpoint, 0, null, null, "waiting for PI init");
                return;
            }
            if (!hasTankOrFlow()) {
                statusSetpoint(lastSetpoint, 0, null, null, "waiting: tank or flow");
                return;
            }

            const tfv = getTankFlowValues();
            const hottest = getHottest();
            if (hottest == null) {
                const missing = [];
                if (tfv.tank == null) missing.push("tank");
                if (tfv.flow == null) missing.push("flow");
                statusSetpoint(lastSetpoint, 0, null, null, missing.length > 0 ? `waiting: ${missing.join(", ")}` : null);
                return;
            }

            if (typeof node._pi.setReferenceSample === "function") {
                node._pi.setReferenceSample(node.refSampleSec);
            }

            // Run clamp PI to get current effective high limit
            const effectiveH = runClampPI();
            const clampReduction = node.heaterLimit - effectiveH;
            const overshoot = Math.max(0, hottest - node.tankFlowLimit);

            // Run main PI step
            const piOutput = node._pi.step(val, { now: Date.now() / 1000 });

            const feedforward = calculateFeedforward();
            const u = piOutput + feedforward;
            const minSp = node.minSetpoint;

            // Clamp to [minSetpoint, effectiveH] - the clamp PI controls effectiveH
            let out = Math.max(minSp, Math.min(effectiveH, u));

            // Anti-windup for main PI: if output is clamped below what PI wants, reduce integral
            // This prevents the main PI from winding up when effectiveH is suppressed
            if (u > effectiveH && typeof node._pi.setIntegral === "function" && typeof node._pi.getIntegral === "function") {
                const currentIntegral = node._pi.getIntegral();
                const excess = u - effectiveH;
                const newIntegral = Math.max(minSp, currentIntegral - excess);
                if (newIntegral < currentIntegral) {
                    node._pi.setIntegral(newIntegral);
                    // Only log occasionally to avoid spam
                    if (Math.random() < 0.1) {
                        node.debug(`[main-antiwindup] integral ${currentIntegral.toFixed(1)} -> ${newIntegral.toFixed(1)} (excess=${excess.toFixed(1)})`);
                    }
                }
            }

            let payloadOut = out;
            if (node.outputInt) payloadOut = Math.round(payloadOut);

            const prevSetpoint = lastSetpoint;
            lastSetpoint = payloadOut;
            const outTopic = node.outputTopic || node.errorTopic;
            node.send({ topic: outTopic, payload: payloadOut });

            // Log when setpoint changes
            const nowMs = Date.now();
            if (prevSetpoint !== null && payloadOut !== prevSetpoint) {
                node.warn(
                    `[calc-change] setpoint=${prevSetpoint}->${payloadOut} | PI=${piOutput.toFixed(1)} ff=${feedforward.toFixed(1)} ` +
                        `effectiveH=${effectiveH.toFixed(1)} clampReduction=${clampReduction.toFixed(1)} | ` +
                        `tank=${tfv.tank?.toFixed(1)} flow=${tfv.flow?.toFixed(1)} overshoot=${overshoot.toFixed(1)}`
                );
            }

            // Periodic detailed logging: every 5 min when clamp is active
            const LOG_INTERVAL_MS = 5 * 60 * 1000;
            const shouldLog = clampReduction > 0.5 && nowMs - lastLogTime > LOG_INTERVAL_MS;
            if (shouldLog) {
                const flowRate = lastValues[node.flowRateTopic];
                const integral = typeof node._pi.getIntegral === "function" ? node._pi.getIntegral() : null;
                node.warn(
                    `[calc] err=${val.toFixed(2)} tank=${tfv.tank?.toFixed(1)} flow=${tfv.flow?.toFixed(1)} flowRate=${flowRate?.toFixed(2) || "n/a"} | ` +
                        `PI=${piOutput.toFixed(1)} ff=${feedforward.toFixed(1)} u=${u.toFixed(1)} | ` +
                        `effectiveH=${effectiveH.toFixed(1)} clampInt=${clampIntegral.toFixed(2)} out=${payloadOut} | ` +
                        `mainInt=${integral?.toFixed(2)}`
                );
                lastLogTime = nowMs;
            }

            statusSetpoint(lastSetpoint, clampReduction, effectiveH, overshoot, null);
        });

        // Periodic save: once per hour
        const SAVE_INTERVAL_MS = 60 * 60 * 1000;
        const saveTimer = setInterval(() => {
            if (node._pi && typeof node._pi.saveState === "function") {
                node._pi.saveState();
                node.debug("PI state saved (hourly)");
            }
        }, SAVE_INTERVAL_MS);

        node.on("close", (done) => {
            clearInterval(saveTimer);
            if (node._pi && typeof node._pi.saveState === "function") {
                node._pi.saveState();
                node.debug("PI state saved (on close)");
            }
            node.status({});
            if (done) done();
        });
    }

    RED.nodes.registerType("uniflex-heater-setpoint-clamp", HeaterSetpointClampNode);
};
