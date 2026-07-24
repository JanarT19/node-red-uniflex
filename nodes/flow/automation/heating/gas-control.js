const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function GasControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.tankTempTopic = (config.tankTempTopic || "").trim();
        node.tankTargetTopic = (config.tankTargetTopic || "").trim();
        node.qNeedTopic = (config.qNeedTopic || "").trim();
        node.enableCmdTopic = (config.enableCmdTopic || "").trim();
        node.blockTopic = (config.blockTopic || "").trim();
        node.spMinTopic = (config.spMinTopic || "").trim();
        node.spMaxTopic = (config.spMaxTopic || "").trim();

        node.outSetpointTopic = (config.outSetpointTopic || "").trim();
        node.outEnableTopic = (config.outEnableTopic || "").trim();
        node.outRequestTopic = (config.outRequestTopic || "").trim();

        // Direct actuator writes (old immergas-control parity)
        node.requestWriteTopic = (config.requestWriteTopic || "HREQV.1").trim();
        node.setpointWriteTopic = (config.setpointWriteTopic || "HSETV.1").trim();
        node.setpointActualTopic = (config.setpointActualTopic || "THFW.2").trim();
        node.pumpHeatingTopic = (config.pumpHeatingTopic || "IMODW.2").trim();
        node.pumpDhwTopic = (config.pumpDhwTopic || "IMODW.3").trim();
        node.flameTopic = (config.flameTopic || "IMODW.4").trim();

        node.forcedWritePeriodSec = Math.max(1, Number(config.forcedWritePeriodSec ?? 20));
        node.stuckTimeoutSec = Math.max(10, Number(config.stuckTimeoutSec ?? 60));
        node.recoveryRetrySec = Math.max(30, Number(config.recoveryRetrySec ?? 300));
        node.recoveryBumpC = Number(config.recoveryBumpC ?? 1.0);
        node.setpointMismatchEpsC = Number(config.setpointMismatchEpsC ?? 0.1);
        node.enableSystemLog = config.enableSystemLog === true;

        node.ffGainCPerKw = Number(config.ffGainCPerKw ?? 0.0);
        node.fbGain = Number(config.fbGain ?? 0.6);
        node.maxTrimC = Number(config.maxTrimC ?? 4.0);
        node.requestValue = Number(config.requestValue ?? 85);

        let tankTemp = null;
        let tankTarget = null;
        let qNeed = 0;
        let enableCmd = 0;
        let block = 0;
        let spMinDyn = null;
        let spMaxDyn = null;
        let currentEnabled = 0;
        let desiredSetpoint = null;
        let actualSetpoint = null;

        // Signals for "stuck" quirk handling
        let pumpHeating = null;
        let pumpDhw = null;
        let flame = null;
        let pumpHeatingTs = 0;
        let pumpDhwTs = 0;
        let flameTs = 0;
        let allOffSince = null;
        let lastRecoveryTs = 0;
        let recoveryTimer = null;

        let lastForcedRequestTs = 0;
        let forcedTimer = null;
        let prevStateLogKey = "";
        const lastSent = {};

        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }
        function as01(v) {
            const n = Number(v);
            return Number.isFinite(n) && n !== 0 ? 1 : 0;
        }
        function sendChanged(topic, payload) {
            if (!topic) return;
            if (lastSent[topic] === payload) return;
            lastSent[topic] = payload;
            node.send({ topic, payload });
        }
        function sendDirect(topic, payload) {
            if (!topic) return;
            node.send({ topic, payload });
        }
        function getClampLimits() {
            let lo = Number.isFinite(spMinDyn) ? spMinDyn : 0;
            let hi = Number.isFinite(spMaxDyn) ? spMaxDyn : 100;
            if (lo > hi) {
                const t = lo;
                lo = hi;
                hi = t;
            }
            return { lo, hi };
        }
        function statusText() {
            const runReason = block ? "OFF:block" : !enableCmd ? "OFF:cmd" : "ON:auto";
            if (!Number.isFinite(desiredSetpoint)) return `${runReason} sp=?`;
            return `${runReason} sp=${desiredSetpoint.toFixed(1)}C`;
        }
        function updateStatus(extra) {
            node.status({
                fill: currentEnabled ? "green" : "grey",
                shape: "dot",
                text: extra ? `${statusText()} ${extra}` : statusText()
            });
        }
        function writeSetpointIfNeeded(targetSp, reason) {
            if (!node.setpointWriteTopic || !Number.isFinite(targetSp)) return;
            const needWrite = !Number.isFinite(actualSetpoint) || Math.abs(targetSp - actualSetpoint) >= node.setpointMismatchEpsC;
            if (!needWrite) return;
            sendDirect(node.setpointWriteTopic, Number(targetSp.toFixed(2)));
            node.debug(`[gas-control] setpoint write ${targetSp.toFixed(2)}C (${reason})`);
        }
        function compute() {
            if (!Number.isFinite(tankTemp) || !Number.isFinite(tankTarget)) return;
            const enabled = enableCmd && !block ? 1 : 0;
            currentEnabled = enabled;
            const { lo, hi } = getClampLimits();
            const err = tankTarget - tankTemp;
            const fbTrim = clamp(node.fbGain * err, -Math.abs(node.maxTrimC), Math.abs(node.maxTrimC));
            const ffTrim = node.ffGainCPerKw * (Number.isFinite(qNeed) ? qNeed : 0);
            desiredSetpoint = clamp(tankTarget + fbTrim + ffTrim, lo, hi);

            sendChanged(node.outEnableTopic, enabled);
            sendChanged(node.outSetpointTopic, Number(desiredSetpoint.toFixed(2)));
            if (node.outRequestTopic) {
                sendChanged(node.outRequestTopic, enabled ? node.requestValue : 0);
            }

            if (enabled) {
                writeSetpointIfNeeded(desiredSetpoint, "compute");
            }
            updateStatus(`err=${err.toFixed(1)}C`);

            const runReason = block ? "OFF:block" : !enableCmd ? "OFF:cmd" : "ON:auto";
            const stateLogKey = `${runReason}|${enabled}|${desiredSetpoint.toFixed(2)}|${err.toFixed(2)}|${Number.isFinite(actualSetpoint) ? actualSetpoint.toFixed(2) : "na"}`;
            if (stateLogKey !== prevStateLogKey) {
                node.log(`[gas-control:${node.name || "unnamed"}] state run=${runReason} en=${enabled} sp=${desiredSetpoint.toFixed(2)}C err=${err.toFixed(2)}C`);
                prevStateLogKey = stateLogKey;
            }
            if (node.enableSystemLog) {
                node.log(
                    `[gas-control:${node.name || "unnamed"}] verbose ` +
                        `cmd=${enableCmd} block=${block} en=${enabled} tank=${tankTemp.toFixed(2)}C target=${tankTarget.toFixed(2)}C qNeed=${Number.isFinite(qNeed) ? qNeed.toFixed(3) : "n/a"} ` +
                        `spDesired=${desiredSetpoint.toFixed(2)}C spActual=${Number.isFinite(actualSetpoint) ? actualSetpoint.toFixed(2) : "n/a"} ` +
                        `trimFB=${fbTrim.toFixed(2)} trimFF=${ffTrim.toFixed(2)} clamps=${lo.toFixed(1)}..${hi.toFixed(1)} ` +
                        `pumpHeat=${pumpHeating == null ? "n/a" : as01(pumpHeating)} pumpDhw=${pumpDhw == null ? "n/a" : as01(pumpDhw)} flame=${flame == null ? "n/a" : as01(flame)}`
                );
            }
        }
        function writeForcedRequest() {
            if (!node.requestWriteTopic) return;
            if (!currentEnabled) return;
            const nowSec = Math.floor(Date.now() / 1000);
            if (nowSec - lastForcedRequestTs < node.forcedWritePeriodSec) return;
            sendDirect(node.requestWriteTopic, node.requestValue);
            lastForcedRequestTs = nowSec;
        }
        function checkStuckAndRecover() {
            if (!currentEnabled || !Number.isFinite(desiredSetpoint)) {
                allOffSince = null;
                return;
            }
            const now = Date.now();
            const staleMs = Math.max(node.forcedWritePeriodSec * 2000, 90000);
            const phOff = pumpHeating == null || now - pumpHeatingTs > staleMs || as01(pumpHeating) === 0;
            const pdOff = pumpDhw == null || now - pumpDhwTs > staleMs || as01(pumpDhw) === 0;
            const flOff = flame == null || now - flameTs > staleMs || as01(flame) === 0;
            const allOff = phOff && pdOff && flOff;
            if (!allOff) {
                allOffSince = null;
                return;
            }
            if (allOffSince == null) {
                allOffSince = now;
                return;
            }
            const offSec = (now - allOffSince) / 1000;
            const sinceRecovery = (now - lastRecoveryTs) / 1000;
            if (offSec < node.stuckTimeoutSec || sinceRecovery < node.recoveryRetrySec) return;
            lastRecoveryTs = now;
            const bumpSp = desiredSetpoint + node.recoveryBumpC;
            node.warn(`[gas-control:${node.name || "unnamed"}] recovery start: off=${offSec.toFixed(0)}s bump=${bumpSp.toFixed(2)}C`);
            writeSetpointIfNeeded(bumpSp, "recovery-bump");
            updateStatus("(recovery)");
            if (recoveryTimer) clearTimeout(recoveryTimer);
            recoveryTimer = setTimeout(() => {
                writeSetpointIfNeeded(desiredSetpoint, "recovery-restore");
                node.log(`[gas-control:${node.name || "unnamed"}] recovery restore: sp=${desiredSetpoint.toFixed(2)}C`);
                updateStatus();
            }, 60000);
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            if (t === node.tankTempTopic) tankTemp = Number(msg.payload);
            else if (t === node.tankTargetTopic) tankTarget = Number(msg.payload);
            else if (t === node.qNeedTopic) qNeed = Number(msg.payload);
            else if (t === node.enableCmdTopic) enableCmd = as01(msg.payload);
            else if (t === node.blockTopic) block = as01(msg.payload);
            else if (t === node.spMinTopic) spMinDyn = Number(msg.payload);
            else if (t === node.spMaxTopic) spMaxDyn = Number(msg.payload);
            else if (t === node.setpointActualTopic) actualSetpoint = Number(msg.payload);
            else if (t === node.pumpHeatingTopic) {
                pumpHeating = msg.payload;
                pumpHeatingTs = Date.now();
            } else if (t === node.pumpDhwTopic) {
                pumpDhw = msg.payload;
                pumpDhwTs = Date.now();
            } else if (t === node.flameTopic) {
                flame = msg.payload;
                flameTs = Date.now();
            } else return;
            compute();
        });

        // Keepalive + stuck-recovery loop (old immergas-control parity).
        forcedTimer = setInterval(() => {
            writeForcedRequest();
            checkStuckAndRecover();
        }, 1000);

        node.on("close", () => {
            if (forcedTimer) {
                clearInterval(forcedTimer);
                forcedTimer = null;
            }
            if (recoveryTimer) {
                clearTimeout(recoveryTimer);
                recoveryTimer = null;
            }
        });
    }
    RED.nodes.registerType("uniflex-gas-control", GasControlNode);
};
