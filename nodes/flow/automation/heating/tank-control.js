const ts = require("../../core/lib/timestamp.js");
const NODE_VERSION = "1.2.0-hsew-hew";
module.exports = function (RED) {
    function TankControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.qNeedBaseTopic = (config.qNeedBaseTopic || "").trim();
        node.estTopic = (config.estTopic || "").trim();
        node.scheduleHpTopic = (config.scheduleHpTopic || "").trim();
        node.scheduleGasTopic = (config.scheduleGasTopic || "").trim();
        node.testTopic1 = (config.testTopic1 || "").trim();
        node.testTopic2 = (config.testTopic2 || "").trim();
        node.testTopic3 = (config.testTopic3 || "").trim();
        node.forceGasTopic = (config.forceGasTopic || "").trim();
        node.forceHpTopic = (config.forceHpTopic || "").trim();
        node.hsewGasTopic = (config.hsewGasTopic || "HSEW.1").trim();
        node.hsewHpTopic = (config.hsewHpTopic || "HSEW.2").trim();
        node.coolRequestTopic = (config.coolRequestTopic || "COOLS.1").trim();
        node.hcmwForceCoolTopic = (config.hcmwForceCoolTopic || "HCMW.2").trim();
        node.hcmwForceHeatTopic = (config.hcmwForceHeatTopic || "HCMW.1").trim();
        node.disGasTopic = (config.disGasTopic || "").trim();
        node.disHpTopic = (config.disHpTopic || "").trim();
        node.gasAvailTopic = (config.gasAvailTopic || "").trim();
        node.hpAvailTopic = (config.hpAvailTopic || "").trim();
        node.enableSystemLog = config.enableSystemLog === true;

        // Emergency dual-source failsafe
        node.enableEmergencyDualSource = config.enableEmergencyDualSource !== false;
        node.emergencyRoomErrThreshold = Number(config.emergencyRoomErrThreshold ?? 2.5);
        node.tankTempFailureThreshold = Number(config.tankTempFailureThreshold ?? 22);
        node.tankTempCriticalThreshold = Number(config.tankTempCriticalThreshold ?? 20);

        node.outQNeedTopic = (config.outQNeedTopic || "").trim();
        node.outTankTargetTopic = (config.outTankTargetTopic || "").trim();
        node.outFlowTargetTopic = (config.outFlowTargetTopic || "").trim();
        node.outGasEnableTopic = (config.outGasEnableTopic || "").trim();
        node.outHpEnableTopic = (config.outHpEnableTopic || "").trim();
        node.outHewGasTopic = (config.outHewGasTopic || "HEW.1").trim();
        node.outHewHpTopic = (config.outHewHpTopic || "HEW.2").trim();
        node.outSwitchNotifyTopic = (config.outSwitchNotifyTopic || "").trim();
        node.outFallbackDiagTopic = (config.outFallbackDiagTopic || "").trim();

        node.roomErrGain = Number(config.roomErrGain ?? 2.0);
        node.testMinQ = Number(config.testMinQ ?? 1.0);
        node.needOnThreshold = Number(config.needOnThreshold ?? 0.3);
        node.needPredHorizonMin = Math.max(0, Number(config.needPredHorizonMin ?? 45));
        node.needPredMaxAbsErr = Math.max(0.1, Number(config.needPredMaxAbsErr ?? 3.0));
        node.roomErrSlopeTauSec = Math.max(1, Number(config.roomErrSlopeTauSec ?? 900));
        node.needAutotuneMode = String(config.needAutotuneMode || "off").toLowerCase();
        if (!["off", "shadow", "active"].includes(node.needAutotuneMode)) node.needAutotuneMode = "off";
        node.tankBase = Number(config.tankBase ?? 30);
        node.qToTankGain = Number(config.qToTankGain ?? 2.5);
        node.tankMin = Number(config.tankMin ?? 30);
        node.tankMax = Number(config.tankMax ?? 50);
        node.flowMin = Number(config.flowMin ?? 0.3);
        node.flowMax = Number(config.flowMax ?? 2.5);
        node.qToFlowGain = Number(config.qToFlowGain ?? 0.35);
        node.hpMinOnSec = Math.max(0, Number(config.hpMinOnSec ?? 1800));
        node.hpMinOffSec = Math.max(0, Number(config.hpMinOffSec ?? 1800));
        node.gasMinOnSec = Math.max(0, Number(config.gasMinOnSec ?? 600));
        node.gasMinOffSec = Math.max(0, Number(config.gasMinOffSec ?? 600));
        // Debounce for schedule 1→0 transitions (guards against iolayer restart glitches)
        node.schDebounceSec = Math.max(0, Number(config.schDebounceSec ?? 30));

        node.log(`[tank-control:${node.name}] *** VERSION ${NODE_VERSION} *** | HCMW cool=${node.hcmwForceCoolTopic} heat=${node.hcmwForceHeatTopic}`);

        const state = {
            qBase: 0,
            roomErr: 0,
            roomErrSlopeCps: 0,
            roomErrLastVal: null,
            roomErrLastTs: 0,
            openFrac: null,
            schHp: null,
            schGas: null,
            tst1: 0,
            tst2: 0,
            tst3: 0,
            fGas: 0,
            fHp: 0,
            hsewGas: 0,
            hsewHp: 0,
            coolReq: 0,
            hcmwForceCool: 0,
            hcmwForceHeat: 0,
            dGas: 0,
            dHp: 0,
            gasAvail: 0,
            hpAvail: 0,
            tankTemp: null
        };
        let emergencyDualSourceActive = false;
        let lastSent = {};
        let lastResendTs = 0;
        const RESEND_INTERVAL_SEC = 60;
        let hpOut = null;
        let gasOut = null;
        let hpLastChangeTs = 0;
        let gasLastChangeTs = 0;
        // Debounce timers for schedule 1→0 transitions (suppress iolayer-restart glitches)
        let schHpDebounceTimer = null;
        let schGasDebounceTimer = null;
        // Glitch flags: set when debounce fires so compute() can pre-expire min-off clock
        let schHpDebounceGlitch = false;
        let schGasDebounceGlitch = false;
        let prevGasManual = false; // Track if gas was in manual control
        let prevHpManual = false; // Track if HP was in manual control
        let prevProblem = null;
        let prevStateKey = "";
        let prevHoldKey = "";
        let prevBypassKey = "";
        let activeSlopeTauSec = node.roomErrSlopeTauSec;
        let prevNeedTuneKey = "";
        let prevVerboseKey = "";
        let lastVerboseLogTs = 0;
        const VERBOSE_MIN_LOG_SEC = 60;
        const tuneState = node.context().get("needTuneState") || {
            dThreshold: 0,
            dHorizonMin: 0,
            dClampDegC: 0,
            dTauSec: 0,
            underVotes: 0,
            overVotes: 0,
            chatterVotes: 0,
            samples: 0,
            lastNeedEligible: null,
            lastApplyTs: 0
        };

        function num(v, defVal = 0) {
            const n = (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
            return n === null ? defVal : n;
        }
        function b01(v) {
            return (v == null || !Number.isFinite(Number(v)) ? null : (Number(v) !== 0 ? 1 : 0));
        }
        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }
        function getEffectiveNeedParams() {
            const base = {
                threshold: Math.max(0, node.needOnThreshold),
                horizonMin: Math.max(0, node.needPredHorizonMin),
                clampDegC: Math.max(0.1, node.needPredMaxAbsErr),
                slopeTauSec: Math.max(1, node.roomErrSlopeTauSec)
            };
            if (node.needAutotuneMode !== "active") return base;
            return {
                threshold: clamp(base.threshold + tuneState.dThreshold, 0.1, 1.5),
                horizonMin: clamp(base.horizonMin + tuneState.dHorizonMin, 15, 180),
                clampDegC: clamp(base.clampDegC + tuneState.dClampDegC, 0.3, 3.0),
                slopeTauSec: clamp(base.slopeTauSec + tuneState.dTauSec, 300, 3600)
            };
        }
        function persistNeedTuneState() {
            node.context().set("needTuneState", tuneState);
        }
        function proposeNeedTuneUpdate(nowTs, underRatio, overRatio, chatterRatio) {
            let dThreshold = tuneState.dThreshold;
            let dHorizonMin = tuneState.dHorizonMin;
            let dClampDegC = tuneState.dClampDegC;
            let dTauSec = tuneState.dTauSec;

            if (underRatio - overRatio > 0.15) {
                dThreshold -= 0.03;
                dHorizonMin += 3;
                dClampDegC += 0.05;
                dTauSec -= 30;
            } else if (overRatio - underRatio > 0.15) {
                dThreshold += 0.03;
                dHorizonMin -= 3;
                dClampDegC -= 0.05;
                dTauSec += 30;
            }
            if (chatterRatio > 0.3) {
                dTauSec += 60;
                dThreshold += 0.02;
            }

            dThreshold = clamp(dThreshold, -0.25, 0.35);
            dHorizonMin = clamp(dHorizonMin, -20, 40);
            dClampDegC = clamp(dClampDegC, -0.8, 1.0);
            dTauSec = clamp(dTauSec, -600, 1800);

            if (node.needAutotuneMode === "active") {
                tuneState.dThreshold = dThreshold;
                tuneState.dHorizonMin = dHorizonMin;
                tuneState.dClampDegC = dClampDegC;
                tuneState.dTauSec = dTauSec;
                tuneState.lastApplyTs = nowTs;
                persistNeedTuneState();
                node.log(
                    `[tank-control:${node.name || "unnamed"}] need-tune applied: ` +
                        `dThr=${dThreshold.toFixed(3)} dHor=${dHorizonMin.toFixed(1)}m dClamp=${dClampDegC.toFixed(2)}C dTau=${dTauSec.toFixed(0)}s ` +
                        `(under=${underRatio.toFixed(2)} over=${overRatio.toFixed(2)} chatter=${chatterRatio.toFixed(2)} n=${tuneState.samples})`
                );
            } else if (node.needAutotuneMode === "shadow") {
                tuneState.lastApplyTs = nowTs;
                persistNeedTuneState();
                node.log(
                    `[tank-control:${node.name || "unnamed"}] need-tune shadow: ` +
                        `suggest dThr=${dThreshold.toFixed(3)} dHor=${dHorizonMin.toFixed(1)}m dClamp=${dClampDegC.toFixed(2)}C dTau=${dTauSec.toFixed(0)}s ` +
                        `(under=${underRatio.toFixed(2)} over=${overRatio.toFixed(2)} chatter=${chatterRatio.toFixed(2)} n=${tuneState.samples})`
                );
            }
            tuneState.underVotes = 0;
            tuneState.overVotes = 0;
            tuneState.chatterVotes = 0;
            tuneState.samples = 0;
            tuneState.lastNeedEligible = null;
        }
        function updateRoomErrTrend(nextRoomErr) {
            const nowTs = Math.floor(Date.now() / 1000);
            const prevVal = state.roomErrLastVal;
            const prevTs = state.roomErrLastTs;
            state.roomErr = nextRoomErr;
            state.roomErrLastVal = nextRoomErr;
            state.roomErrLastTs = nowTs;
            if (prevVal == null || prevTs <= 0 || nowTs <= prevTs) return;
            const dtSec = nowTs - prevTs;
            if (dtSec <= 0 || dtSec > 1800) return;
            const rawSlope = (nextRoomErr - prevVal) / dtSec;
            const alpha = clamp(dtSec / (activeSlopeTauSec + dtSec), 0, 1);
            state.roomErrSlopeCps = state.roomErrSlopeCps + alpha * (rawSlope - state.roomErrSlopeCps);
        }
        function sendChanged(topic, payload) {
            if (!topic) return;
            if (lastSent[topic] === payload) return;
            lastSent[topic] = payload;
            node.send({ topic, payload });
        }
        // Debounced schedule setters: 1 applies immediately (cancels pending 0);
        // 0 is delayed by schDebounceSec to absorb iolayer-restart glitches.
        function setSchHp(val) {
            if (val === 1) {
                if (schHpDebounceTimer) {
                    clearTimeout(schHpDebounceTimer);
                    schHpDebounceTimer = null;
                }
                if (state.schHp !== 1) {
                    state.schHp = 1;
                    compute(true);
                }
            } else {
                if (schHpDebounceTimer !== null) return; // already pending
                if (node.schDebounceSec <= 0) {
                    state.schHp = 0;
                    compute(true);
                } else {
                    schHpDebounceTimer = setTimeout(() => {
                        schHpDebounceTimer = null;
                        if (state.schHp !== 0) {
                            state.schHp = 0;
                            schHpDebounceGlitch = true;
                            compute(true);
                        }
                    }, node.schDebounceSec * 1000);
                }
            }
        }
        function setSchGas(val) {
            if (val === 1) {
                if (schGasDebounceTimer) {
                    clearTimeout(schGasDebounceTimer);
                    schGasDebounceTimer = null;
                }
                if (state.schGas !== 1) {
                    state.schGas = 1;
                    compute(true);
                }
            } else {
                if (schGasDebounceTimer !== null) return;
                if (node.schDebounceSec <= 0) {
                    state.schGas = 0;
                    compute(true);
                } else {
                    schGasDebounceTimer = setTimeout(() => {
                        schGasDebounceTimer = null;
                        if (state.schGas !== 0) {
                            state.schGas = 0;
                            schGasDebounceGlitch = true;
                            compute(true);
                        }
                    }, node.schDebounceSec * 1000);
                }
            }
        }

        function applyMinHold(desired, current, lastChangeTs, minOnSec, minOffSec, nowTs) {
            if (current == null) {
                return { out: desired, ts: 0, blocked: 0, reason: "init", remainingSec: 0 };
            }
            if (desired === current) {
                return { out: current, ts: lastChangeTs, blocked: 0, reason: "none", remainingSec: 0 };
            }
            const elapsed = nowTs - lastChangeTs;
            if (current === 1 && desired === 0 && elapsed < minOnSec) {
                return {
                    out: 1,
                    ts: lastChangeTs,
                    blocked: 1,
                    reason: "min_on",
                    remainingSec: Math.max(0, Math.ceil(minOnSec - elapsed))
                };
            }
            if (current === 0 && desired === 1 && elapsed < minOffSec) {
                return {
                    out: 0,
                    ts: lastChangeTs,
                    blocked: 1,
                    reason: "min_off",
                    remainingSec: Math.max(0, Math.ceil(minOffSec - elapsed))
                };
            }
            return { out: desired, ts: nowTs, blocked: 0, reason: "none", remainingSec: 0 };
        }

        // Periodic warning while waiting for schedule inputs after NR restart
        let waitingLogTimer = null;
        function startWaitingLog() {
            if (waitingLogTimer) return;
            waitingLogTimer = setInterval(() => {
                const missing = [];
                if (state.schHp === null) missing.push(node.scheduleHpTopic || "scheduleHp");
                if (state.schGas === null) missing.push(node.scheduleGasTopic || "scheduleGas");
                if (missing.length === 0) {
                    clearInterval(waitingLogTimer);
                    waitingLogTimer = null;
                } else {
                    node.warn(`[tank-control:${node.name || "unnamed"}] Waiting for schedule inputs: ${missing.join(", ")} -- outputs suppressed until received`);
                }
            }, 60000);
        }

        function compute(tunePulse = false) {
            // Suppress outputs until both schedule inputs have been received at least once after NR restart.
            // schHp/schGas start as null; first real message sets them to 0 or 1.
            if (state.schHp === null || state.schGas === null) {
                startWaitingLog();
                return;
            }
            if (waitingLogTimer) {
                clearInterval(waitingLogTimer);
                waitingLogTimer = null;
            }
            try {
                const needParams = getEffectiveNeedParams();
                activeSlopeTauSec = needParams.slopeTauSec;
                const testOn = state.tst1 || state.tst2 || state.tst3;
                const predRoomErrRaw = state.roomErr + state.roomErrSlopeCps * (needParams.horizonMin * 60);
                const predRoomErr = clamp(predRoomErrRaw, -needParams.clampDegC, needParams.clampDegC);
                const baseNeed = Math.max(0, state.qBase + node.roomErrGain * predRoomErr);
                const qNeed = testOn ? Math.max(baseNeed, node.testMinQ) : baseNeed;
                const needFromDemand = qNeed > needParams.threshold ? 1 : 0;
                const needFromPlan = state.schGas || state.schHp ? 1 : 0;
                const needHeat = needFromPlan || needFromDemand ? 1 : 0;
                const needReason = needFromPlan ? "plan" : needFromDemand ? "predictive" : "off";

                const tankTarget = clamp(node.tankBase + qNeed * node.qToTankGain, node.tankMin, node.tankMax);
                let flowTarget = clamp(node.flowMin + qNeed * node.qToFlowGain, node.flowMin, node.flowMax);
                if (state.openFrac != null) {
                    const cap = node.flowMin + (node.flowMax - node.flowMin) * clamp(state.openFrac, 0, 1);
                    flowTarget = Math.min(flowTarget, cap);
                }

                const watchdogMode = !!(node.gasAvailTopic || node.hpAvailTopic);
                const gasAvail = node.gasAvailTopic ? (b01(state.gasAvail) ? 0 : 1) : 1;
                const hpAvail = node.hpAvailTopic ? (b01(state.hpAvail) ? 0 : 1) : 1;
                let prefName = "NONE";
                let prefUnavailable = 0;
                let fallbackActive = 0;

                const gasAutoLegacy = needHeat && state.schGas;
                const hpAutoLegacy = needHeat && state.schHp;
                // HSEW: manual source enable (run even when predictive need is off). HSMW force* is separate (hold bypass / legacy force).
                let desiredGas = state.dGas ? 0 : state.fGas || state.hsewGas ? 1 : gasAutoLegacy ? 1 : 0;
                let desiredHp = state.dHp ? 0 : state.fHp || state.hsewHp || state.coolReq || state.hcmwForceCool || state.hcmwForceHeat ? 1 : hpAutoLegacy ? 1 : 0;

                if (watchdogMode) {
                    const gasBlocked = state.dGas || !gasAvail;
                    const hpBlocked = state.dHp || !hpAvail;
                    const gasReady = gasBlocked ? 0 : 1;
                    const hpReady = hpBlocked ? 0 : 1;
                    const hasForce = state.fGas || state.fHp;
                    const prefHp = needHeat && state.schHp && !state.schGas;
                    const prefGas = needHeat && state.schGas && !state.schHp;
                    const dualSched = needHeat && state.schHp && state.schGas;
                    prefName = prefHp ? "HP" : prefGas ? "GAS" : "NONE";

                    desiredGas = 0;
                    desiredHp = 0;

                    // Step 1: Apply HSMW force to override preference (source selection testing)
                    let effectivePrefHp = prefHp;
                    let effectivePrefGas = prefGas;
                    if (state.fGas && !state.fHp) {
                        // Force gas preference for testing
                        effectivePrefGas = needHeat;
                        effectivePrefHp = false;
                    } else if (state.fHp && !state.fGas) {
                        // Force HP preference for testing
                        effectivePrefHp = needHeat;
                        effectivePrefGas = false;
                    } else if (state.fGas && state.fHp) {
                        // Force both (dual mode)
                        effectivePrefHp = false;
                        effectivePrefGas = false;
                    }

                    // Step 2: Determine base desired state from schedule/need with forced preference
                    if (effectivePrefHp) {
                        if (hpReady) desiredHp = 1;
                        else if (gasReady) desiredGas = 1;
                    } else if (effectivePrefGas) {
                        if (gasReady) desiredGas = 1;
                        else if (hpReady) desiredHp = 1;
                    } else if (dualSched || (state.fGas && state.fHp && needHeat)) {
                        desiredGas = gasReady ? 1 : 0;
                        desiredHp = hpReady ? 1 : 0;
                    }

                    // Step 3: HSEW overrides - enable source even when needHeat is 0
                    if (state.hsewGas && gasReady) desiredGas = 1;
                    if (state.hsewHp && hpReady) desiredHp = 1;

                    // Step 4: HP cooling request (COOLS.1 from hp-control) or HCMW forced cool/heat
                    if ((state.coolReq || state.hcmwForceCool || state.hcmwForceHeat) && hpReady) desiredHp = 1;

                    prefUnavailable = (prefHp && !hpReady) || (prefGas && !gasReady) ? 1 : 0;
                }

                // EMERGENCY DUAL-SOURCE FAILSAFE
                // Uses aggregate room error (from state-observer) instead of per-room emergency flags
                // Trigger if: high room error AND (tank too cold OR no schedule)
                // Exit if: tank >= setpoint2 AND room error improved
                if (node.enableEmergencyDualSource) {
                    const roomEmergency = state.roomErr > node.emergencyRoomErrThreshold;
                    const anySourceEnabled = desiredGas || desiredHp ? 1 : 0;
                    const noSchedule = !state.schHp && !state.schGas ? 1 : 0;

                    let triggerEmergency = false;
                    let exitEmergency = false;

                    if (roomEmergency) {
                        // Option A logic: (tank < 22°C AND source enabled) OR (tank < 20°C)
                        if (state.tankTemp != null) {
                            const heatDeliveryFailure = state.tankTemp < node.tankTempFailureThreshold && anySourceEnabled;
                            const criticalCold = state.tankTemp < node.tankTempCriticalThreshold;
                            triggerEmergency = heatDeliveryFailure || criticalCold || noSchedule;
                        } else if (noSchedule) {
                            // If no tank temp but no schedule, still trigger
                            triggerEmergency = true;
                        }
                    }

                    // Exit conditions: tank recovered above failure threshold AND room error improved
                    if (emergencyDualSourceActive) {
                        if (!roomEmergency && state.tankTemp != null && state.tankTemp >= node.tankTempFailureThreshold) {
                            exitEmergency = true;
                        }
                    }

                    // State transitions
                    if (triggerEmergency && !emergencyDualSourceActive) {
                        emergencyDualSourceActive = true;
                        const reason =
                            state.tankTemp != null && state.tankTemp < node.tankTempCriticalThreshold
                                ? "critical cold"
                                : state.tankTemp != null && state.tankTemp < node.tankTempFailureThreshold
                                  ? "heat delivery failure"
                                  : "no schedule";
                        node.warn(
                            `[tank-control:${node.name || "unnamed"}] EMERGENCY DUAL-SOURCE ENTERED: ` +
                                `roomErr=${state.roomErr.toFixed(1)}°C>threshold=${node.emergencyRoomErrThreshold}°C tankT=${state.tankTemp != null ? state.tankTemp.toFixed(1) : "null"}°C ` +
                                `reason=${reason} sch(g/h)=${state.schGas}/${state.schHp} src=${enGas}/${enHp} → forcing both sources`
                        );
                    } else if (exitEmergency && emergencyDualSourceActive) {
                        emergencyDualSourceActive = false;
                        node.log(
                            `[tank-control:${node.name || "unnamed"}] EMERGENCY DUAL-SOURCE EXITED: ` +
                                `roomErr=${state.roomErr.toFixed(1)}°C tankT=${state.tankTemp != null ? state.tankTemp.toFixed(1) : "null"}°C ` +
                                `>= failureThreshold=${node.tankTempFailureThreshold}°C → resuming normal control`
                        );
                    }

                    // Apply emergency: force both sources (bypass all other logic)
                    if (emergencyDualSourceActive) {
                        if (watchdogMode) {
                            desiredGas = gasReady ? 1 : 0;
                            desiredHp = hpReady ? 1 : 0;
                        } else {
                            desiredGas = state.dGas ? 0 : 1;
                            desiredHp = state.dHp ? 0 : 1;
                        }
                    }
                }

                const nowTs = Math.floor(Date.now() / 1000);
                let heldGas = { out: desiredGas, ts: gasLastChangeTs, blocked: 0, reason: "none", remainingSec: 0 };
                let heldHp = { out: desiredHp, ts: hpLastChangeTs, blocked: 0, reason: "none", remainingSec: 0 };

                const gasManual = !!(state.dGas || state.fGas || state.hsewGas);
                const hpManual = !!(state.dHp || state.fHp || state.hsewHp || state.coolReq);

                // Gas hold logic: only apply hold during auto-auto transitions
                if (gasManual) {
                    // During manual control: bypass hold, output=desired
                    gasOut = desiredGas;
                    gasLastChangeTs = nowTs;
                    schGasDebounceGlitch = false;
                } else if (prevGasManual) {
                    // Just exited manual: allow immediate change without hold, then reset timestamp
                    gasOut = desiredGas;
                    gasLastChangeTs = nowTs;
                    schGasDebounceGlitch = false;
                } else {
                    // Auto mode (no recent manual): apply hold timer
                    heldGas = applyMinHold(desiredGas, gasOut, gasLastChangeTs, node.gasMinOnSec, node.gasMinOffSec, nowTs);
                    gasOut = heldGas.out;
                    // Pre-expire min-off clock if this 0-transition was triggered by a debounce glitch,
                    // so that when the schedule recovers the gas is not held off for gasMinOffSec.
                    gasLastChangeTs = gasOut === 0 && schGasDebounceGlitch ? nowTs - node.gasMinOffSec : heldGas.ts;
                    schGasDebounceGlitch = false;
                }

                // HP hold logic: only apply hold during auto-auto transitions
                if (hpManual) {
                    // During manual control: bypass hold, output=desired
                    hpOut = desiredHp;
                    hpLastChangeTs = nowTs;
                    schHpDebounceGlitch = false;
                } else if (prevHpManual) {
                    // Just exited manual: allow immediate change without hold, then reset timestamp
                    hpOut = desiredHp;
                    hpLastChangeTs = nowTs;
                    schHpDebounceGlitch = false;
                } else {
                    // Auto mode (no recent manual): apply hold timer
                    heldHp = applyMinHold(desiredHp, hpOut, hpLastChangeTs, node.hpMinOnSec, node.hpMinOffSec, nowTs);
                    hpOut = heldHp.out;
                    // Pre-expire min-off clock if this 0-transition was triggered by a debounce glitch,
                    // so that when the schedule recovers HP is not held off for hpMinOffSec.
                    hpLastChangeTs = hpOut === 0 && schHpDebounceGlitch ? nowTs - node.hpMinOffSec : heldHp.ts;
                    schHpDebounceGlitch = false;
                }

                prevGasManual = gasManual;
                prevHpManual = hpManual;
                const enGas = gasOut == null ? desiredGas : gasOut;
                const enHp = hpOut == null ? desiredHp : hpOut;
                fallbackActive = prefUnavailable && ((prefName === "HP" && enGas) || (prefName === "GAS" && enHp)) ? 1 : 0;

                const sourceNow = enGas && enHp ? "GAS+HP" : enGas ? "GAS" : enHp ? "HP" : "NONE";
                const cannotHeat = needHeat && !enGas && !enHp;
                const holdBlocking = cannotHeat && (heldGas.blocked || heldHp.blocked) && !(watchdogMode && prefUnavailable);
                const hasProblem = (cannotHeat && !holdBlocking) || (watchdogMode && prefUnavailable);
                const hasHold = holdBlocking;
                const healthTag = hasProblem ? "PROBLEM" : hasHold ? "HOLD" : "OK";
                const needTxt = needHeat ? "need" : "no-need";
                const stateKey = `${needHeat}|${needReason}|${sourceNow}|${prefName}|${prefUnavailable}|${fallbackActive}|${healthTag}`;
                const holdKey =
                    `hp:${heldHp.reason}:${heldHp.remainingSec}|gas:${heldGas.reason}:${heldGas.remainingSec}|` +
                    `hpBypass:${state.dHp ? "disable" : state.fHp || state.hsewHp || state.coolReq ? "force" : "none"}|` +
                    `gasBypass:${state.dGas ? "disable" : state.fGas || state.hsewGas ? "force" : "none"}|` +
                    `coolReq:${state.coolReq}`;
                const needTuneKey =
                    `${node.needAutotuneMode}|thr=${needParams.threshold.toFixed(3)}|hor=${needParams.horizonMin.toFixed(1)}|` +
                    `clamp=${needParams.clampDegC.toFixed(2)}|tau=${needParams.slopeTauSec.toFixed(0)}|` +
                    `d=${tuneState.dThreshold.toFixed(3)}/${tuneState.dHorizonMin.toFixed(1)}/${tuneState.dClampDegC.toFixed(2)}/${tuneState.dTauSec.toFixed(0)}`;
                const bypassKey =
                    `hp:${state.dHp ? "disable" : state.fHp || state.hsewHp || state.coolReq ? "force" : "none"}|` +
                    `gas:${state.dGas ? "disable" : state.fGas || state.hsewGas ? "force" : "none"}|` +
                    `coolReq:${state.coolReq}`;

                if (hasProblem && prevProblem !== true) {
                    node.warn(
                        `[tank-control:${node.name || "unnamed"}] PROBLEM entered: need=${needHeat} src=${sourceNow} pref=${prefName} sw=${prefUnavailable}/${fallbackActive} q=${qNeed.toFixed(2)}kW`
                    );
                } else if (!hasProblem && prevProblem === true) {
                    node.log(
                        `[tank-control:${node.name || "unnamed"}] PROBLEM cleared: need=${needHeat} src=${sourceNow} pref=${prefName} sw=${prefUnavailable}/${fallbackActive}`
                    );
                }
                if (stateKey !== prevStateKey) {
                    node.log(
                        `[tank-control:${node.name || "unnamed"}] state: ` +
                            `need=${needHeat}:${needReason} src=${sourceNow} pref=${prefName} sw=${prefUnavailable}/${fallbackActive} enGas=${enGas} enHp=${enHp} health=${healthTag}`
                    );
                }
                if (holdKey !== prevHoldKey) {
                    if (heldHp.blocked || heldGas.blocked) {
                        node.log(
                            `[tank-control:${node.name || "unnamed"}] hold: ` +
                                `hp=${heldHp.reason}${heldHp.blocked ? `(${heldHp.remainingSec}s)` : ""} ` +
                                `gas=${heldGas.reason}${heldGas.blocked ? `(${heldGas.remainingSec}s)` : ""} ` +
                                `desired(g/h)=${desiredGas}/${desiredHp} out(g/h)=${enGas}/${enHp}`
                        );
                    }
                }
                if (bypassKey !== prevBypassKey) {
                    if (state.dHp || state.fHp || state.hsewHp || state.coolReq || state.dGas || state.fGas || state.hsewGas) {
                        node.warn(
                            `[tank-control:${node.name || "unnamed"}] hold bypass active: ` +
                                `hp=${state.dHp ? "disable" : state.fHp || state.hsewHp || state.coolReq ? "force" : "none"} ` +
                                `gas=${state.dGas ? "disable" : state.fGas || state.hsewGas ? "force" : "none"} ` +
                                `coolReq=${state.coolReq}`
                        );
                    } else {
                        node.log(`[tank-control:${node.name || "unnamed"}] hold bypass cleared`);
                    }
                }
                if (needTuneKey !== prevNeedTuneKey) {
                    if (node.needAutotuneMode !== "off") {
                        node.log(
                            `[tank-control:${node.name || "unnamed"}] need-tune mode=${node.needAutotuneMode} ` +
                                `effective(thr/hor/clamp/tau)=${needParams.threshold.toFixed(3)}/${needParams.horizonMin.toFixed(1)}m/${needParams.clampDegC.toFixed(2)}C/${needParams.slopeTauSec.toFixed(0)}s ` +
                                `delta=${tuneState.dThreshold.toFixed(3)}/${tuneState.dHorizonMin.toFixed(1)}m/${tuneState.dClampDegC.toFixed(2)}C/${tuneState.dTauSec.toFixed(0)}s`
                        );
                    }
                }
                if (node.enableSystemLog) {
                    const verboseKey =
                        `${state.qBase.toFixed(3)}|${state.roomErr.toFixed(3)}|${(state.roomErrSlopeCps * 3600).toFixed(3)}|` +
                        `${predRoomErr.toFixed(3)}|${needParams.horizonMin.toFixed(0)}|${state.openFrac == null ? "n/a" : state.openFrac.toFixed(3)}|` +
                        `${qNeed.toFixed(3)}|${needHeat}:${needReason}|${state.schGas}/${state.schHp}|${state.fGas}/${state.fHp}|hsew=${state.hsewGas}/${state.hsewHp}|cool=${state.coolReq}|${state.dGas}/${state.dHp}|` +
                        `${gasAvail}/${hpAvail}|${desiredGas}/${desiredHp}|${enGas}/${enHp}|${heldGas.reason}:${heldGas.remainingSec}|${heldHp.reason}:${heldHp.remainingSec}|` +
                        `${prefName}|${prefUnavailable}|${fallbackActive}|${hasProblem}|${tankTarget.toFixed(2)}|${flowTarget.toFixed(3)}`;
                    const due = nowTs - lastVerboseLogTs >= VERBOSE_MIN_LOG_SEC;
                    if (verboseKey !== prevVerboseKey || due) {
                        node.log(
                            `[tank-control:${node.name || "unnamed"}] verbose ` +
                                `qBase=${state.qBase.toFixed(3)} roomErr=${state.roomErr.toFixed(3)} roomErrSlope=${(state.roomErrSlopeCps * 3600).toFixed(3)}C/h ` +
                                `roomErrPred=${predRoomErr.toFixed(3)} horizon=${needParams.horizonMin.toFixed(0)}m openFrac=${state.openFrac == null ? "n/a" : state.openFrac.toFixed(3)} ` +
                                `qNeed=${qNeed.toFixed(3)} need=${needHeat}:${needReason} sch(g/h)=${state.schGas}/${state.schHp} force(g/h)=${state.fGas}/${state.fHp} hsew(g/h)=${state.hsewGas}/${state.hsewHp} coolReq=${state.coolReq} dis(g/h)=${state.dGas}/${state.dHp} ` +
                                `availOK(g/h)=${gasAvail}/${hpAvail} desired(g/h)=${desiredGas}/${desiredHp} out(g/h)=${enGas}/${enHp} ` +
                                `hold(g on/off)=${node.gasMinOnSec}/${node.gasMinOffSec}s hold(hp on/off)=${node.hpMinOnSec}/${node.hpMinOffSec}s ` +
                                `holdState(g/h)=${heldGas.reason}${heldGas.blocked ? `:${heldGas.remainingSec}s` : ""}/${heldHp.reason}${heldHp.blocked ? `:${heldHp.remainingSec}s` : ""} ` +
                                `pref=${prefName} prefUnavailable=${prefUnavailable} fallback=${fallbackActive} health=${healthTag} ` +
                                `targets(tank/flow)=${tankTarget.toFixed(2)}/${flowTarget.toFixed(3)}`
                        );
                        prevVerboseKey = verboseKey;
                        lastVerboseLogTs = nowTs;
                    }
                }
                prevProblem = hasProblem;
                prevStateKey = stateKey;
                prevHoldKey = holdKey;
                prevBypassKey = bypassKey;
                prevNeedTuneKey = needTuneKey;

                const canTuneNeed = !needFromPlan && !testOn && !state.fGas && !state.fHp && !state.hsewGas && !state.hsewHp && !state.dGas && !state.dHp;
                if (canTuneNeed) {
                    tuneState.samples += 1;
                    if (!needHeat && predRoomErr > 0.25) tuneState.underVotes += 1;
                    if (needHeat && predRoomErr < -0.15) tuneState.overVotes += 1;
                    if (tuneState.lastNeedEligible != null && tuneState.lastNeedEligible !== needHeat) tuneState.chatterVotes += 1;
                    tuneState.lastNeedEligible = needHeat;
                } else {
                    tuneState.lastNeedEligible = null;
                }
                const nowTuneTs = nowTs;
                if (node.needAutotuneMode !== "off" && tunePulse && tuneState.samples >= 30) {
                    const underRatio = tuneState.underVotes / Math.max(1, tuneState.samples);
                    const overRatio = tuneState.overVotes / Math.max(1, tuneState.samples);
                    const chatterRatio = tuneState.chatterVotes / Math.max(1, tuneState.samples);
                    proposeNeedTuneUpdate(nowTuneTs, underRatio, overRatio, chatterRatio);
                }

                if (nowTs - lastResendTs >= RESEND_INTERVAL_SEC) {
                    lastSent = {};
                    lastResendTs = nowTs;
                }

                sendChanged(node.outQNeedTopic, Number(qNeed.toFixed(3)));
                sendChanged(node.outTankTargetTopic, Number(tankTarget.toFixed(2)));
                sendChanged(node.outFlowTargetTopic, Number(flowTarget.toFixed(3)));

                sendChanged(node.outGasEnableTopic, enGas);
                sendChanged(node.outHpEnableTopic, enHp);
                if (node.outHewGasTopic) sendChanged(node.outHewGasTopic, enGas);
                if (node.outHewHpTopic) sendChanged(node.outHewHpTopic, enHp);
                if (node.outSwitchNotifyTopic) {
                    sendChanged(`${node.outSwitchNotifyTopic}.1`, prefUnavailable);
                    sendChanged(`${node.outSwitchNotifyTopic}.2`, fallbackActive);
                }
                if (node.outFallbackDiagTopic) {
                    // 3-member boolean diagnostic stream (all 0/1):
                    // .1 = emergency dual-source active
                    // .2 = no-schedule fallback active
                    // .3 = source-failure fallback active (watchdog)
                    const noSched = !state.schHp && !state.schGas ? 1 : 0;
                    const noSchedFallback = needHeat && noSched && !state.fGas && !state.fHp && !state.hsewGas && !state.hsewHp ? 1 : 0;

                    sendChanged(`${node.outFallbackDiagTopic}.1`, emergencyDualSourceActive ? 1 : 0);
                    sendChanged(`${node.outFallbackDiagTopic}.2`, noSchedFallback);
                    sendChanged(`${node.outFallbackDiagTopic}.3`, prefUnavailable);
                }

                node.status({
                    fill: hasProblem ? "red" : hasHold ? "yellow" : enGas || enHp ? "green" : "grey",
                    shape: "dot",
                    text: `${needTxt}:${needReason} src=${sourceNow}${emergencyDualSourceActive ? " EMERG-DUAL" : ""}${watchdogMode ? ` pref=${prefName} sw=${prefUnavailable}/${fallbackActive}` : ""}${hasProblem ? " PROBLEM" : hasHold ? " HOLD" : ""}`
                });
            } catch (err) {
                node.error(`COMPUTE ERROR: ${err.message} at ${err.stack}`);
            }
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            const p = msg.payload;

            if (t === node.qNeedBaseTopic) {
                const n = (p == null ? null : (Number.isFinite(Number(p)) ? Number(p) : null));
                if (n === null) return;
                state.qBase = Math.max(0, n);
            } else if (t === node.estTopic && p && typeof p === "object") {
                if ((p.roomErr != null && Number.isFinite(Number(p.roomErr)))) updateRoomErrTrend(num(p.roomErr, state.roomErr));
                if ((p.openFrac != null && Number.isFinite(Number(p.openFrac)))) state.openFrac = clamp(num(p.openFrac, 0), 0, 1);
                if ((p.tankTemp != null && Number.isFinite(Number(p.tankTemp)))) state.tankTemp = num(p.tankTemp, state.tankTemp);
            } else if (t === node.scheduleGasTopic) {
                const bit = b01(p);
                if (bit === null) return;
                setSchGas(bit);
                return;
            } else if (t === node.scheduleHpTopic) {
                const bit = b01(p);
                if (bit === null) return;
                setSchHp(bit);
                return;
            } else if (t === node.testTopic1) {
                const bit = b01(p);
                if (bit === null) return;
                state.tst1 = bit;
            } else if (t === node.testTopic2) {
                const bit = b01(p);
                if (bit === null) return;
                state.tst2 = bit;
            } else if (t === node.testTopic3) {
                const bit = b01(p);
                if (bit === null) return;
                state.tst3 = bit;
            } else if (t === node.forceGasTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.fGas = bit;
            } else if (t === node.forceHpTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.fHp = bit;
            } else if (node.hsewGasTopic && t === node.hsewGasTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.hsewGas = bit;
            } else if (node.hsewHpTopic && t === node.hsewHpTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.hsewHp = bit;
            } else if (node.coolRequestTopic && t === node.coolRequestTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.coolReq = bit;
            } else if (node.hcmwForceCoolTopic && t === node.hcmwForceCoolTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.hcmwForceCool = bit;
            } else if (node.hcmwForceHeatTopic && t === node.hcmwForceHeatTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.hcmwForceHeat = bit;
            } else if (t === node.disGasTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.dGas = bit;
            } else if (t === node.disHpTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.dHp = bit;
            } else if (t === node.gasAvailTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.gasAvail = bit;
            } else if (t === node.hpAvailTopic) {
                const bit = b01(p);
                if (bit === null) return;
                state.hpAvail = bit;
            } else return;

            const tunePulse = t === node.qNeedBaseTopic;
            compute(tunePulse);
        });

        node.on("close", () => {
            if (schHpDebounceTimer) {
                clearTimeout(schHpDebounceTimer);
                schHpDebounceTimer = null;
            }
            if (schGasDebounceTimer) {
                clearTimeout(schGasDebounceTimer);
                schGasDebounceTimer = null;
            }
            if (waitingLogTimer) {
                clearInterval(waitingLogTimer);
                waitingLogTimer = null;
            }
        });
    }

    RED.nodes.registerType("uniflex-tank-control", TankControlNode);
};
