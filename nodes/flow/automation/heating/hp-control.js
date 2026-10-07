const ts = require("../../core/lib/timestamp.js");
const NODE_VERSION = "2.3.7-test-pwm";
module.exports = function (RED) {
    const fs = require("fs");
    const path = require("path");

    function HpControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.tankTempTopic = (config.tankTempTopic || "").trim();
        node.tankSetpointTopic = (config.tankSetpointTopic || "").trim(); // From mpc-house
        node.targetTopic = (config.targetTopic || config.tankTargetTopic || config.heatTargetTopic || "").trim();
        // Tank setpoint to HP setpoint conversion (heat exchanger temperature drop)
        node.deltaT_base = Math.max(0, cfgNum(config.deltaT_base, 4.0)); // C base offset
        node.deltaT_slope = Math.max(0, cfgNum(config.deltaT_slope, 0.3)); // C per kW
        node.enableCmdTopic = (config.enableCmdTopic || config.enableHeatCmdTopic || "").trim();
        node.hcmwForceHeatTopic = (config.hcmwForceHeatTopic || "HCMW.1").trim();
        node.hcmwForceCoolTopic = (config.hcmwForceCoolTopic || "HCMW.2").trim();

        // HP setpoint limits (fixed configuration, not dynamic topics)
        node.spMin = Math.max(0, cfgNum(config.spMin, 28)); // C
        node.spMax = Math.max(0, cfgNum(config.spMax, 51)); // C

        // Deprecated dynamic clamp topics (kept for backward compatibility, but ignored if spMin/spMax configured)
        node.spMinTopic = (config.spMinTopic || "").trim();
        node.spMaxTopic = (config.spMaxTopic || "").trim();
        const rawLogLevel = config.logLevel != null && config.logLevel !== "" ? String(config.logLevel) : config.enableSystemLog === true ? "verbose" : "basic";
        node.logLevel = ["off", "basic", "verbose"].includes(rawLogLevel) ? rawLogLevel : "basic";
        function cfgNum(val, fallback) {
            if (val === "" || val == null) return fallback;
            const n = Number(val);
            return Number.isFinite(n) ? n : fallback;
        }
        node.lookAheadSec = Math.max(0, cfgNum(config.lookAheadSec, 120));
        // Fixed spread between SP1 and SP2 for both heating and cooling pairs
        node.spread = Math.max(1, cfgNum(config.minSpread, 3));

        // Auto-cooling: decision from room-overheat-checker via coolingRequiredTopic
        node.autoEnableCooling = !!config.autoEnableCooling;
        node.coolingRequiredTopic = (config.coolingRequiredTopic || "heating/coolingRequired").trim();
        node.coolPriceLimit = cfgNum(config.coolPriceLimit, 50); // EUR/MWh for air coil gate
        node.coolSpUpper = cfgNum(config.coolSpUpper, 18); // ESTTW.4 fixed
        node.coolSpLower = cfgNum(config.coolSpLower, 15); // ESTTW.5 fixed
        node.spotPriceTopic = (config.spotPriceTopic || "PRENW.3").trim();

        node.outHeatEnableTopic = (config.outHeatEnableTopic || config.outEnableTopic || "").trim();
        node.outCoolEnableTopic = (config.outCoolEnableTopic || "").trim();
        node.outLowModeTopic = (config.outLowModeTopic || "").trim();
        node.outHeatSp1Topic = (config.outHeatSp1Topic || config.outHighSpTopic || "").trim();
        node.outHeatSp2Topic = (config.outHeatSp2Topic || config.outLowSpTopic || "").trim();
        node.outCoolSp1Topic = (config.outCoolSp1Topic || "").trim();
        node.outCoolSp2Topic = (config.outCoolSp2Topic || "").trim();
        node.outCoolModeGlobalTopic = (config.outCoolModeGlobalTopic || "").trim(); // COOLS.1
        node.outHewCoolTopic = (config.outHewCoolTopic || "HEW.3").trim();
        node.outAirCoolEnableTopic = (config.outAirCoolEnableTopic || "").trim(); // HK5S.1

        // Persistence configuration
        node.persistencePath = (config.persistencePath || "").trim();
        {
            const _pfx = "hp-control";
            const _safe = (node.name || node.id).replace(/\s+/g, "-");
            const _stem = _safe === _pfx || _safe.startsWith(_pfx + "-") ? _safe : `${_pfx}-${_safe}`;
            node.persistenceFile = node.persistencePath ? path.join(node.persistencePath, `${_stem}.json`) : null;
        }

        // HP bump/stall detection configuration
        node.tankActualTopic = (config.tankActualTopic || "ESTTW.1").trim();
        node.compSpeedTopic = (config.compSpeedTopic || "ESCSV.1").trim();
        node.avgValveOpenTopic = (config.avgValveOpenTopic || "HVAVV.1").trim();
        node.valveGateThresholdPct = Math.max(0, cfgNum(config.valveGateThresholdPct, 5.0));
        node.valveGateChargeBypassDeg = cfgNum(config.valveGateChargeBypassDeg, 0.5); // min chargeAdj to bypass gate
        node.valveGateChargeMinKwh = cfgNum(config.valveGateChargeMinKwh, 2.0); // min remaining HP plan (kWh)
        node.gasEnableTopic = (config.gasEnableTopic || "ISETW.4").trim(); // Gas heat request
        node.outErrorKey = (config.outErrorKey || "ESMSW").trim(); // Key only, will append .1-.5
        node.bumpTempBias = cfgNum(config.bumpTempBias, 2.0); // C bias below SP2 (ESTTW.3)

        // ESMSW bit definitions (member numbers)
        const ESMW_BIT_HP_NORUN = 1; // ESMSW.1: Compressor stalled after bump
        const ESMW_BIT_BUMPING = 2; // ESMSW.2: Bump XOR active
        const ESMW_BIT_DUAL_SOURCE = 3; // ESMSW.3: Both gas and HP enabled
        const ESMW_BIT_NO_HEAT = 4; // ESMSW.4: Tank cold >10min while heat needed
        const ESMW_BIT_RESERV = 5; // ESMSW.5: Reserved for future use

        const BUMP_STALL_TIMEOUT_SEC = 10 * 60; // 10 minutes of zero speed
        const BUMP_DURATION_SEC = 60; // Activate low mode for 1 minute
        const NO_HEAT_TIMEOUT_SEC = 10 * 60; // 10 minutes tank cold
        const HEAT_NEEDED_VALVE_PCT = 30; // Valve openness threshold

        let tankTemp = null;
        let tankSetpoint = null; // From mpc-house
        let P_max_12h = null; // From mpc-house schedule context
        let target = null;
        let enableCmd = null; // null = not yet received; 0/1 after first enableCmdTopic message
        let forceHeat = 0;
        let forceCool = 0;
        let spMinDyn = null;
        let spMaxDyn = null;
        let heatEnabled = 0;
        let coolEnabled = 0;
        let lowMode = 0;
        let lastSpWriteTs = 0;
        let lastCoolSpWriteTs = 0;

        // HP bump/stall detection state
        let tankActual = null;
        let compSpeed = null;
        let compSpeedZeroSince = null; // Timestamp when compressor went to zero
        let bumpActivatedAt = null; // Timestamp when bump was activated
        let bumpInProgress = false;
        let avgValveOpenness = null; // HVAVV.1 (0-100%)
        let valveGateSuppressing = false; // true when valve gate is blocking HP due to low demand
        let gasEnabled = 0; // ISETW.1
        let noHeatSince = null; // Timestamp when no-heat condition started
        let errorBitValues = {
            // Individual bit states (0 or 1)
            [ESMW_BIT_HP_NORUN]: 0,
            [ESMW_BIT_BUMPING]: 0,
            [ESMW_BIT_DUAL_SOURCE]: 0,
            [ESMW_BIT_NO_HEAT]: 0,
            [ESMW_BIT_RESERV]: 0
        };

        // Auto-cooling state (decision external via room-overheat-checker)
        let spotPrice = null;
        let externalCoolingRequired = 0;
        let coolModeGlobal = 0;
        let airCoolEnable = 0;

        // ESSWW run mode: never jump heat <-> cool directly; always pass through off.
        let hpRunMode = "off";

        // Duty-based setpoint tuning (replaces old bias system)
        let targetSp1 = null; // Absolute target setpoints (persistent)
        let targetSp2 = null;
        let lastBiasAdjustTs = 0;
        let heatEnableTransitions = []; // [{ts: number, state: 0|1}, ...] for ESSWW.2
        let lowModeTransitions = []; // [{ts: number, state: 0|1}, ...] for ESSWW.3
        let currentHeatEnableState = null;
        let currentLowModeState = null;
        const DUTY_HEATING_TIME_SEC = 6 * 3600; // Need 6h of actual heating time
        const MAX_TRANSITIONS = 100; // Hard limit to prevent unbounded growth
        const BIAS_CHECK_INTERVAL_SEC = 6 * 3600; // Check every 6h
        const DUTY_TARGET_MIN = 0.25;
        const DUTY_TARGET_MAX = 0.75;
        const DUTY_EXTREME_MIN = 0.125;
        const DUTY_EXTREME_MAX = 0.875;
        const BIAS_STEP_NORMAL_C = 1.0;
        const BIAS_STEP_EXTREME_C = 2.0;

        let initSp1 = null;
        let biasInitialized = false;
        const derivWindowSec = Math.max(10, cfgNum(config.derivWindowSec, 60));
        const derivBuf = [];
        let tankRateCph = 0;
        let prevStateLogKey = "";
        let prevVerboseKey = "";
        let lastVerboseLogTs = 0;
        let usingFallback = false; // Track fallback mode to avoid log spam
        let leadLogged = false;
        const VERBOSE_MIN_LOG_SEC = 60;
        let enableCmdWaitingLogTimer = null; // Periodic warning if enableCmdTopic never arrives
        const lastSent = {};
        const LOW_MODE_ERR_C = 0.5;
        const LOW_HOT_HYST_C = 1;
        const TEST_PWM_PERIOD_SEC = 60;
        node.testPwmDuringForce = config.testPwmDuringForce === true || config.testPwmDuringForce === "true";
        node.testPwmDutyPct = Number(config.testPwmDutyPct);
        if (!Number.isFinite(node.testPwmDutyPct)) node.testPwmDutyPct = 50;
        node.testPwmDutyPct = Math.max(0, Math.min(100, node.testPwmDutyPct));
        const SP_MIN_WRITE_SEC = 12 * 3600;

        // Setpoint monitoring and auto-correction
        let heatSp1Written = null; // What we last wrote
        let heatSp2Written = null;
        let coolSp1Written = null;
        let coolSp2Written = null;
        let heatSp1Actual = null; // Read back from HP
        let heatSp2Actual = null;
        let coolSp1Actual = null;
        let coolSp2Actual = null;
        let lastSpCheckTs = 0;
        const SP_CHECK_INTERVAL_SEC = 300; // Check every 5 minutes
        const SP_TOLERANCE_C = 0.5; // Allow 0.5C deviation

        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }
        function as01(v) {
            return (v == null || !Number.isFinite(Number(v)) ? null : (Number(v) !== 0 ? 1 : 0));
        }
        function sendChanged(topic, payload) {
            if (!topic) return false;
            if (lastSent[topic] === payload) return false;
            lastSent[topic] = payload;
            node.send({ topic, payload });
            return true;
        }

        function failSafeDisable(reason) {
            heatEnabled = 0;
            coolEnabled = 0;
            coolModeGlobal = 0;
            airCoolEnable = 0;
            sendChanged(node.outHeatEnableTopic, 0);
            sendChanged(node.outCoolEnableTopic, 0);
            sendChanged(node.outCoolModeGlobalTopic, 0);
            if (node.outHewCoolTopic) sendChanged(node.outHewCoolTopic, 0);
            sendChanged(node.outAirCoolEnableTopic, 0);
            sendChanged(node.outLowModeTopic, 0);
            node.status({ fill: "grey", shape: "ring", text: reason || "unknown input" });
        }

        // Persistence: load/save state to file
        function loadState() {
            if (!node.persistenceFile) return false;
            const filePath = node.persistenceFile;
            try {
                const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
                targetSp1 = data.targetSp1 || null;
                targetSp2 = data.targetSp2 || null;
                lastBiasAdjustTs = data.lastBiasAdjustTs || 0;
                tankSetpoint = data.tankSetpoint || null; // Restore last known MPC setpoint
                P_max_12h = data.P_max_12h || null; // Restore last known max power
                heatEnableTransitions = data.heatEnableTransitions || [];
                lowModeTransitions = data.lowModeTransitions || [];
                // Trim transitions based on heating time (not wall clock time)
                trimTransitionBuffers();
                node.log(
                    `[hp-control:${node.name}] State loaded: SP1=${targetSp1}, SP2=${targetSp2}, tankSP=${tankSetpoint != null ? tankSetpoint.toFixed(1) : "null"}C, P_max=${P_max_12h != null ? P_max_12h.toFixed(1) : "null"}kW, heatTrans=${heatEnableTransitions.length}, lowTrans=${lowModeTransitions.length}`
                );
                return true;
            } catch (e) {
                node.debug(`[hp-control:${node.name}] No previous state file or invalid: ${e.message}`);
                return false;
            }
        }

        function saveState() {
            if (!node.persistenceFile) return;
            const filePath = node.persistenceFile;
            try {
                // Trim transitions before saving
                trimTransitionBuffers();
                const data = {
                    targetSp1: targetSp1,
                    targetSp2: targetSp2,
                    lastBiasAdjustTs: lastBiasAdjustTs,
                    tankSetpoint: tankSetpoint, // Save last known MPC setpoint
                    P_max_12h: P_max_12h, // Save last known max power
                    heatEnableTransitions: heatEnableTransitions,
                    lowModeTransitions: lowModeTransitions
                };
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
                node.log(
                    `[hp-control:${node.name}] State saved: SP1=${targetSp1}, SP2=${targetSp2}, tankSP=${tankSetpoint != null ? tankSetpoint.toFixed(1) : "null"}C, P_max=${P_max_12h != null ? P_max_12h.toFixed(1) : "null"}kW`
                );
            } catch (e) {
                node.error(`[hp-control:${node.name}] Failed to save state: ${e.message}`);
            }
        }

        function trimTransitionBuffers() {
            // Calculate total heating time from heatEnableTransitions
            const nowSec = Math.floor(Date.now() / 1000);
            const heatingTime = calculateHeatingTime(nowSec, heatEnableTransitions);

            // We want to keep enough history to have DUTY_HEATING_TIME_SEC of actual heating
            // Work backwards from now until we accumulate that much heating time
            if (heatEnableTransitions.length === 0) return;

            let accumulatedHeatingTime = 0;
            let cutoffTs = nowSec;

            // Walk backwards through heat enable transitions
            for (let i = heatEnableTransitions.length - 1; i >= 0; i--) {
                const trans = heatEnableTransitions[i];
                const nextTs = i === heatEnableTransitions.length - 1 ? nowSec : heatEnableTransitions[i + 1].ts;

                if (trans.state === 1) {
                    const duration = nextTs - trans.ts;
                    accumulatedHeatingTime += duration;

                    if (accumulatedHeatingTime >= DUTY_HEATING_TIME_SEC) {
                        // Found the cutoff point
                        cutoffTs = trans.ts;
                        break;
                    }
                }
                cutoffTs = trans.ts;
            }

            // Trim both buffers to cutoff timestamp
            heatEnableTransitions = heatEnableTransitions.filter((t) => t.ts >= cutoffTs);
            lowModeTransitions = lowModeTransitions.filter((t) => t.ts >= cutoffTs);

            // Apply hard limit: keep only the most recent MAX_TRANSITIONS entries
            if (heatEnableTransitions.length > MAX_TRANSITIONS) {
                heatEnableTransitions = heatEnableTransitions.slice(-MAX_TRANSITIONS);
            }
            if (lowModeTransitions.length > MAX_TRANSITIONS) {
                lowModeTransitions = lowModeTransitions.slice(-MAX_TRANSITIONS);
            }
        }

        // Calculate total time with state=1 from transition buffer
        function calculateActiveTime(nowSec, transitions) {
            if (transitions.length === 0) return 0;

            let totalTime = 0;
            let currentState = transitions[0].state;
            let lastTs = transitions[0].ts;

            for (let i = 1; i < transitions.length; i++) {
                const trans = transitions[i];
                if (currentState === 1) {
                    totalTime += trans.ts - lastTs;
                }
                currentState = trans.state;
                lastTs = trans.ts;
            }

            // Add current state duration up to now
            if (currentState === 1) {
                totalTime += nowSec - lastTs;
            }

            return totalTime;
        }

        function calculateHeatingTime(nowSec, heatTransitions) {
            return calculateActiveTime(nowSec, heatTransitions);
        }

        // Calculate duty cycle: time in low mode / time heating
        function calculateDuty(nowSec, silent = false) {
            if (heatEnableTransitions.length === 0 || lowModeTransitions.length === 0) {
                // No data yet, assume neutral duty
                return 0.5;
            }

            const heatingTime = calculateHeatingTime(nowSec, heatEnableTransitions);

            // Check if we have enough heating time
            if (heatingTime < DUTY_HEATING_TIME_SEC) {
                // Insufficient heating time, assume neutral duty
                if (!silent) {
                    node.debug(`[hp-control:${node.name}] Insufficient heating time: ${(heatingTime / 3600).toFixed(1)}h < 6h`);
                }
                return 0.5;
            }

            // Calculate time in low mode (only during heating periods)
            let lowModeTime = 0;

            // Merge the two transition streams to calculate overlapping time
            // For simplicity: calculate total low mode time, but only count periods when heating was also active

            // Create a merged timeline of both signals
            const allEvents = [];
            heatEnableTransitions.forEach((t) => allEvents.push({ ts: t.ts, type: "heat", state: t.state }));
            lowModeTransitions.forEach((t) => allEvents.push({ ts: t.ts, type: "low", state: t.state }));
            allEvents.sort((a, b) => a.ts - b.ts);

            let heatState = 0;
            let lowState = 0;
            let lastTs = allEvents[0].ts;

            for (const event of allEvents) {
                // Accumulate low mode time only when both heat=1 AND low=1
                if (heatState === 1 && lowState === 1) {
                    lowModeTime += event.ts - lastTs;
                }

                // Update states
                if (event.type === "heat") {
                    heatState = event.state;
                } else {
                    lowState = event.state;
                }
                lastTs = event.ts;
            }

            // Add final segment up to now
            if (heatState === 1 && lowState === 1) {
                lowModeTime += nowSec - lastTs;
            }

            const duty = lowModeTime / heatingTime;
            return duty;
        }

        function updateDerivative(temp, nowSec) {
            derivBuf.push({ ts: nowSec, v: temp });
            const cutoff = nowSec - derivWindowSec;
            while (derivBuf.length > 0 && derivBuf[0].ts < cutoff) derivBuf.shift();
            if (derivBuf.length < 2) {
                tankRateCph = 0;
                return;
            }
            const span = derivBuf[derivBuf.length - 1].ts - derivBuf[0].ts;
            if (span < 10) {
                return;
            }
            let tSum = 0,
                vSum = 0;
            for (const s of derivBuf) {
                tSum += s.ts;
                vSum += s.v;
            }
            const tMean = tSum / derivBuf.length;
            const vMean = vSum / derivBuf.length;
            let num = 0,
                den = 0;
            for (const s of derivBuf) {
                const dt = s.ts - tMean;
                num += dt * (s.v - vMean);
                den += dt * dt;
            }
            tankRateCph = den > 0 ? (num / den) * 3600 : 0;
        }
        function tryInitBias() {
            if (biasInitialized) return;
            if (initSp1 == null) return;
            // Bias initialization removed - no longer using supplyTarget
            biasInitialized = true;
        }

        function getClampLimits() {
            // Configured spMin/spMax are the HP register limits.
            // HTSW.3/.4 are the tank operating limits and must not pull the HP pair down.
            let lo = node.spMin;
            let hi = node.spMax;
            if (!(lo > 0) && Number.isFinite(spMinDyn) && spMinDyn > 0) lo = spMinDyn;
            if (!(hi > 0) && Number.isFinite(spMaxDyn) && spMaxDyn > 0) hi = spMaxDyn;
            if (lo > hi) {
                const tmp = lo;
                lo = hi;
                hi = tmp;
            }
            return { lo, hi };
        }

        /**
         * Heating pair: clamp heating2 (lower) to [lo, hi], then heating1 = heating2 + spread.
         * heating1 is NOT clamped to hi -- heat transfer needs the delta above tank.
         */
        function computeHeatSp(rawUpper, spread, lo, hi) {
            // Clamp baseUpper first to respect spMax, ensuring spread fits
            const upperClamped = clamp(rawUpper, lo + spread, hi);

            // Round to whole degrees -- most HPs store setpoints as integers
            const sp1 = Math.round(upperClamped);
            const sp2 = Math.round(upperClamped - spread);

            // Final safety: ensure sp2 doesn't go below spMin
            const sp2_final = Math.max(lo, sp2);

            return { sp1, sp2: sp2_final };
        }

        function fmtAutoCoolNum(v, decimals) {
            return v != null && Number.isFinite(v) ? Number(v).toFixed(decimals) : "n/a";
        }

        function isHcmwAutoMode() {
            return !forceHeat && !forceCool;
        }

        function resolveCoolActive() {
            if (forceHeat) return 0;
            if (forceCool) return 1;
            if (node.autoEnableCooling && externalCoolingRequired) return 1;
            return 0;
        }

        function autoCoolVerboseSuffix(coolActive) {
            const hcmwSuffix = ` hcmw=fH${forceHeat}/fC${forceCool} autoMode=${isHcmwAutoMode() ? 1 : 0}`;
            if (!node.autoEnableCooling) {
                return `${hcmwSuffix} autoEn=0 coolAct=${coolActive ? 1 : 0}`;
            }
            return `${hcmwSuffix} autoEn=1 coolReq=${externalCoolingRequired ? 1 : 0} ` + `spot=${fmtAutoCoolNum(spotPrice, 2)} coolAct=${coolActive ? 1 : 0}`;
        }

        function applyHpRunModeGuard(wantHeat, wantCool) {
            let outHeat = 0;
            let outCool = 0;
            if (wantCool) {
                if (hpRunMode === "heat") {
                    hpRunMode = "off";
                } else {
                    outCool = 1;
                    hpRunMode = "cool";
                }
            } else if (wantHeat) {
                if (hpRunMode === "cool") {
                    hpRunMode = "off";
                } else {
                    outHeat = 1;
                    hpRunMode = "heat";
                }
            } else {
                hpRunMode = "off";
            }
            return { heat: outHeat, cool: outCool };
        }

        function emitCoolSetpoints(nowSec, skipIntervalCheck) {
            if (!node.outCoolSp1Topic && !node.outCoolSp2Topic) return false;

            // Always use fixed setpoints from UI config
            const coolSp1 = node.coolSpUpper; // e.g., 17C
            const coolSp2 = node.coolSpLower; // e.g., 14C

            const sp1Val = Number(coolSp1.toFixed(2));
            const sp2Val = Number(coolSp2.toFixed(2));

            // Wait until we've read back HP's actual cooling setpoints before writing
            const modbusReady = coolSp1Actual != null && coolSp2Actual != null;
            if (!modbusReady) {
                return false;
            }

            // Check if HP's actual values differ from what we want
            const sp1NeedsWrite = Math.abs(coolSp1Actual - sp1Val) > 0.1;
            const sp2NeedsWrite = Math.abs(coolSp2Actual - sp2Val) > 0.1;

            // Skip write if HP already has correct values and not forced
            if (!sp1NeedsWrite && !sp2NeedsWrite && !skipIntervalCheck) {
                return false;
            }

            if (!skipIntervalCheck) {
                if (nowSec - lastCoolSpWriteTs < SP_MIN_WRITE_SEC) return false;
            }

            // Snapshot old actuals for log before optimistic update
            const prevCoolActual1 = coolSp1Actual;
            const prevCoolActual2 = coolSp2Actual;

            const c1Sent = sendChanged(node.outCoolSp1Topic, sp1Val);
            const c2Sent = sendChanged(node.outCoolSp2Topic, sp2Val);

            if (c1Sent || c2Sent) {
                if (c1Sent) coolSp1Actual = sp1Val;
                if (c2Sent) coolSp2Actual = sp2Val;

                if (node.logLevel !== "off" && (sp1NeedsWrite || sp2NeedsWrite)) {
                    const sp1Msg = c1Sent ? `SP1: ${prevCoolActual1.toFixed(2)}C -> ${sp1Val}C (${node.outCoolSp1Topic})` : `SP1: dedup`;
                    const sp2Msg = c2Sent ? `SP2: ${prevCoolActual2.toFixed(2)}C -> ${sp2Val}C (${node.outCoolSp2Topic})` : `SP2: dedup`;
                    node.log(`[hp-control:${node.name}] WRITE cooling: ${sp1Msg}, ${sp2Msg}`);
                }

                lastCoolSpWriteTs = nowSec;
                coolSp1Written = sp1Val;
                coolSp2Written = sp2Val;
            }

            return true;
        }

        /**
         * HP Bump Logic: Monitors compressor stall and activates low mode briefly to restart
         * Updates: ESMSW.1 (HP_NORUN) and ESMSW.2 (BUMPING)
         */
        function monitorCompressorBump(nowSec) {
            // Need required inputs
            if (tankActual == null || heatSp2Written == null || compSpeed == null) return;

            // Clear error bit and status if compressor is running
            if (compSpeed > 0) {
                if (errorBitValues[ESMW_BIT_HP_NORUN]) {
                    errorBitValues[ESMW_BIT_HP_NORUN] = 0;
                    sendChanged(`${node.outErrorKey}.${ESMW_BIT_HP_NORUN}`, 0);
                    node.log(`[hp-control:${node.name}] Compressor started, clearing stall error`);
                }
                if (bumpInProgress) {
                    bumpInProgress = false;
                    node.log(`[hp-control:${node.name}] Bump successful, compressor running`);
                }
                compSpeedZeroSince = null;
                return;
            }

            // Track how long compressor has been at zero
            if (compSpeed === 0) {
                if (compSpeedZeroSince == null) {
                    compSpeedZeroSince = nowSec;
                }
            }

            // Check if bump is in progress
            if (bumpInProgress) {
                const bumpElapsed = nowSec - bumpActivatedAt;
                if (bumpElapsed >= BUMP_DURATION_SEC) {
                    // Bump duration expired, check result
                    bumpInProgress = false;
                    node.log(`[hp-control:${node.name}] Bump complete`);

                    // Check if compressor is still at zero after bump
                    if (compSpeed === 0) {
                        errorBitValues[ESMW_BIT_HP_NORUN] = 1;
                        sendChanged(`${node.outErrorKey}.${ESMW_BIT_HP_NORUN}`, 1);
                        node.warn(`[hp-control:${node.name}] Compressor still stalled after bump! Error bit set.`);
                        node.status({ fill: "red", shape: "ring", text: "STALL after bump" });
                    }
                }
                return;
            }

            // Check stall condition: heat enabled, tank below ESTTW.3 - bias, compressor stalled
            const tankTooCold = tankActual < heatSp2Written - node.bumpTempBias;
            const stallCondition =
                heatEnabled === 1 && // Heat is enabled
                !bumpInProgress && // Not currently bumping
                tankTooCold && // Tank too cold
                compSpeedZeroSince != null &&
                nowSec - compSpeedZeroSince >= BUMP_STALL_TIMEOUT_SEC; // Stalled for 10 min

            if (stallCondition && !errorBitValues[ESMW_BIT_HP_NORUN]) {
                // Don't bump repeatedly if already failed
                // Activate bump - will XOR lowMode at output
                bumpInProgress = true;
                bumpActivatedAt = nowSec;
                node.log(
                    `[hp-control:${node.name}] HP BUMPED: tank=${tankActual.toFixed(1)}C < ESTTW.3-${node.bumpTempBias}C=${(heatSp2Written - node.bumpTempBias).toFixed(1)}C, speed=0 for ${((nowSec - compSpeedZeroSince) / 60).toFixed(0)}min`
                );
                node.status({ fill: "yellow", shape: "ring", text: "hp bumped" });
            }
        }

        /**
         * Update all ESMSW error bits based on current system state
         * Writes to individual members: ESMSW.1 through ESMSW.5
         */
        function updateErrorBits(nowSec) {
            // Bit 1 (ESMSW.1): HP_NORUN - handled by monitorCompressorBump

            // Bit 2 (ESMSW.2): BUMPING - bump operation active
            const bumpingVal = bumpInProgress ? 1 : 0;
            if (errorBitValues[ESMW_BIT_BUMPING] !== bumpingVal) {
                errorBitValues[ESMW_BIT_BUMPING] = bumpingVal;
                sendChanged(`${node.outErrorKey}.${ESMW_BIT_BUMPING}`, bumpingVal);
            }

            // Bit 3 (ESMSW.3): DUAL_SOURCE - both gas and HP enabled
            const dualSourceVal = heatEnabled === 1 && gasEnabled === 1 ? 1 : 0;
            if (errorBitValues[ESMW_BIT_DUAL_SOURCE] !== dualSourceVal) {
                errorBitValues[ESMW_BIT_DUAL_SOURCE] = dualSourceVal;
                sendChanged(`${node.outErrorKey}.${ESMW_BIT_DUAL_SOURCE}`, dualSourceVal);
            }

            // Bit 4 (ESMSW.4): NO_HEAT - tank cold while heat needed
            // Heat needed: HVAVV.1 > 30% (valves open) OR heatEnabled (fallback)
            const heatNeeded = (avgValveOpenness != null && avgValveOpenness > HEAT_NEEDED_VALVE_PCT) || heatEnabled === 1;
            const tankTooLow = tankActual != null && heatSp2Written != null && tankActual < heatSp2Written - node.bumpTempBias;

            if (heatNeeded && tankTooLow) {
                if (noHeatSince == null) {
                    noHeatSince = nowSec;
                }
                if (nowSec - noHeatSince >= NO_HEAT_TIMEOUT_SEC) {
                    if (!errorBitValues[ESMW_BIT_NO_HEAT]) {
                        errorBitValues[ESMW_BIT_NO_HEAT] = 1;
                        sendChanged(`${node.outErrorKey}.${ESMW_BIT_NO_HEAT}`, 1);
                    }
                }
            } else {
                noHeatSince = null;
                if (errorBitValues[ESMW_BIT_NO_HEAT]) {
                    errorBitValues[ESMW_BIT_NO_HEAT] = 0;
                    sendChanged(`${node.outErrorKey}.${ESMW_BIT_NO_HEAT}`, 0);
                }
            }

            // Bit 5 (ESMSW.5): Reserved (always clear for now)
            if (errorBitValues[ESMW_BIT_RESERV]) {
                errorBitValues[ESMW_BIT_RESERV] = 0;
                sendChanged(`${node.outErrorKey}.${ESMW_BIT_RESERV}`, 0);
            }
        }

        function syncCoolingRequiredFromContext() {
            const ctxCool = node.context().flow.get("coolingRequired");
            if (typeof ctxCool === "number") {
                externalCoolingRequired = ctxCool ? 1 : 0;
            }
        }

        function compute(forceSetpointWrite, heatSpOnly) {
            syncCoolingRequiredFromContext();
            if (tankTemp == null || target == null) {
                failSafeDisable("unknown tank/target");
                return;
            }
            // Wait for hp_enable unless HCMW forces heat/cool (forced mode bootstraps via tank-control).
            if (enableCmd === null && !forceCool && !forceHeat) {
                if (!enableCmdWaitingLogTimer) {
                    enableCmdWaitingLogTimer = setInterval(() => {
                        if (enableCmd !== null) {
                            clearInterval(enableCmdWaitingLogTimer);
                            enableCmdWaitingLogTimer = null;
                        } else {
                            node.warn(`[hp-control:${node.name}] Waiting for enable command (${node.enableCmdTopic || "enableCmdTopic"}) -- ESSWW outputs suppressed`);
                        }
                    }, 60000);
                }
                return;
            }
            if (enableCmdWaitingLogTimer) {
                clearInterval(enableCmdWaitingLogTimer);
                enableCmdWaitingLogTimer = null;
            }
            const nowSec = Math.floor(Date.now() / 1000);

            const { lo, hi } = getClampLimits();
            const activeHeatTarget = Number.isFinite(target) ? target : tankTemp;

            const heatErr = activeHeatTarget - tankTemp;

            // Cooling error: calculate against fixed cooling setpoint from UI
            // (cooling uses fixed UI config values, not dynamic calculation)
            const coolErr = tankTemp - node.coolSpLower; // Error vs lower cooling setpoint

            const coolActive = resolveCoolActive() ? 1 : 0;

            // Determine cooling outputs
            coolModeGlobal = coolActive; // COOLS.1 - global cooling mode for floor valves

            // Air cooling: enabled if cooling active AND price allows (forced cool ignores price)
            if (coolActive && !forceCool && spotPrice != null && Number.isFinite(spotPrice)) {
                airCoolEnable = spotPrice < node.coolPriceLimit ? 1 : 0;
            } else {
                airCoolEnable = coolActive;
            }

            const hpRunAllowed = enableCmd === 1 || forceCool === 1 || forceHeat === 1;
            let wantHeat = 0;
            if (hpRunAllowed && !coolActive) {
                if (forceHeat) {
                    wantHeat = 1;
                } else if (enableCmd && !forceCool) {
                    wantHeat = 1;
                }
            }

            // Valve gate: suppress HP heating when no room is calling for heat.
            // Hysteresis: gate activates below threshold, releases at threshold + 2%.
            // Forced heating (HCMW.1) bypasses the valve gate.
            if (wantHeat && !forceHeat && node.valveGateThresholdPct > 0 && Number.isFinite(avgValveOpenness)) {
                const gateOnAt = node.valveGateThresholdPct;
                const gateOffAt = node.valveGateThresholdPct + 2.0;
                if (!valveGateSuppressing && avgValveOpenness < gateOnAt) {
                    valveGateSuppressing = true;
                    node.log(`[hp-control:${node.name}] Valve gate ON: avgValve=${avgValveOpenness.toFixed(1)}% < ${gateOnAt}% -- suppressing HP`);
                } else if (valveGateSuppressing && avgValveOpenness >= gateOffAt) {
                    valveGateSuppressing = false;
                    node.log(`[hp-control:${node.name}] Valve gate OFF: avgValve=${avgValveOpenness.toFixed(1)}% >= ${gateOffAt}% -- allowing HP`);
                }
                if (valveGateSuppressing) wantHeat = 0;
            } else if (!wantHeat) {
                valveGateSuppressing = false; // reset gate when schedule disables HP
            }

            // Price pre-charge bypass: if valve gate is suppressing but MPC plans heating in a
            // cheap slot (chargeAdj >= threshold) and there is enough remaining planned HP energy,
            // override the gate so the HP can actually pre-charge the house.
            if (valveGateSuppressing && node.valveGateChargeBypassDeg > 0) {
                let chargeBypassNow = 0;
                let bypassRemainingHpKwh = 0;
                try {
                    const cSig = node.context().global.get("chargeSignal");
                    if (cSig && Array.isArray(cSig.adj) && cSig.baseSlot && cSig.stepSec && Date.now() - (cSig.timestamp || 0) < 10800000) {
                        const nowSec = Math.floor(Date.now() / 1000);
                        const s = Math.max(0, Math.floor((nowSec - cSig.baseSlot) / cSig.stepSec));
                        chargeBypassNow = Number.isFinite(cSig.adj[s]) ? cSig.adj[s] : 0;
                    }
                } catch (e) {
                    node.debug(`[hp-control:${node.name}] chargeSignal read err: ${e.message}`);
                }

                if (chargeBypassNow >= node.valveGateChargeBypassDeg) {
                    try {
                        const fNodes = RED.nodes.getFlowNodes(node.z);
                        const mpcN = fNodes && fNodes.find((n) => n.type === "uniflex-mpc-house");
                        if (mpcN) {
                            const sc = RED.nodes.getNode(mpcN.id).context().get("schedule");
                            if (sc && sc.hp_ena && sc.Q && sc.baseSlot && sc.slotDurationUsed) {
                                const nowSec = Math.floor(Date.now() / 1000);
                                const slotHrs = sc.slotDurationUsed / 3600;
                                bypassRemainingHpKwh = sc.hp_ena.reduce((sum, on, i) => {
                                    const ts = sc.baseSlot + i * sc.slotDurationUsed;
                                    return sum + (on && ts >= nowSec ? (sc.Q[i] || 0) * slotHrs : 0);
                                }, 0);
                            }
                        }
                    } catch (e) {
                        node.debug(`[hp-control:${node.name}] schedule read err: ${e.message}`);
                    }

                    if (bypassRemainingHpKwh >= node.valveGateChargeMinKwh) {
                        wantHeat = 1;
                        node.log(
                            `[hp-control:${node.name}] Valve gate bypassed (price pre-charge): charge=+${chargeBypassNow.toFixed(2)}C remain=${bypassRemainingHpKwh.toFixed(1)}kWh`
                        );
                    }
                }
            }

            const wantCool = coolActive && hpRunAllowed ? 1 : 0;
            const guarded = applyHpRunModeGuard(wantHeat, wantCool);
            heatEnabled = guarded.heat;
            coolEnabled = guarded.cool;
            sendChanged(node.outHeatEnableTopic, heatEnabled);
            sendChanged(node.outCoolEnableTopic, coolEnabled);
            sendChanged(node.outCoolModeGlobalTopic, coolModeGlobal); // COOLS.1
            if (node.outHewCoolTopic) sendChanged(node.outHewCoolTopic, coolModeGlobal);
            sendChanged(node.outAirCoolEnableTopic, airCoolEnable); // HK5S.1

            // Heating low selects the lower HP setpoint. The compressor stops about 5 C
            // above whichever setpoint is active, so low is only for a tank that has
            // reached the upper setpoint. The 180 s tank rate stays in the log only.
            const ratePerSec = tankRateCph / 3600;
            let predictedErr = 0;
            if (heatEnabled) {
                predictedErr = heatErr - ratePerSec * node.lookAheadSec;
                const hi = Number(targetSp1);
                const tankNow = tankActual != null ? tankActual : tankTemp;
                if (Number.isFinite(hi) && Number.isFinite(tankNow)) {
                    if (tankNow >= hi) lowMode = 1;
                    else if (tankNow <= hi - LOW_HOT_HYST_C) lowMode = 0;
                }
            } else if (coolEnabled) {
                predictedErr = Math.max(coolErr, 0) - Math.max(0, ratePerSec) * node.lookAheadSec;
                if (predictedErr < LOW_MODE_ERR_C) lowMode = 1;
                else if (predictedErr > LOW_MODE_ERR_C) lowMode = 0;
            } else {
                lowMode = 0;
            }

            // Forced-heat test: fixed 60 s period, duty is the share spent on the
            // lower setpoint (low relay on). 100 keeps low on, 0 keeps the upper
            // setpoint. Aligned to the clock minute. Normal heating ignores this.
            let testPwmActive = false;
            if (node.testPwmDuringForce && forceHeat === 1 && heatEnabled) {
                testPwmActive = true;
                const onSec = TEST_PWM_PERIOD_SEC * node.testPwmDutyPct / 100;
                const phase = nowSec % TEST_PWM_PERIOD_SEC;
                lowMode = phase < onSec ? 1 : 0;
            }

            const activeNow = heatEnabled || coolEnabled ? 1 : 0;

            // Track heat enable transitions for duty calculation
            if (currentHeatEnableState !== heatEnabled) {
                heatEnableTransitions.push({ ts: nowSec, state: heatEnabled });
                currentHeatEnableState = heatEnabled;
                node.debug(`[hp-control:${node.name}] Heat enable transition: ${heatEnabled}`);
            }

            // Track low-mode transitions for duty calculation
            if (currentLowModeState !== lowMode) {
                lowModeTransitions.push({ ts: nowSec, state: lowMode });
                currentLowModeState = lowMode;
                node.debug(`[hp-control:${node.name}] Low-mode transition: ${lowMode}`);
            }

            // Duty is observed only. It must not move the heating pair.
            // The pair comes from the mpc-house full recalc (hpSetpointPair).
            let dutyText = "n/a";
            let adjustReason = "plan-hold";

            if (nowSec - lastBiasAdjustTs >= BIAS_CHECK_INTERVAL_SEC) {
                const duty = calculateDuty(nowSec);
                dutyText = `${(duty * 100).toFixed(1)}%`;
                lastBiasAdjustTs = nowSec;
                node.log(`[hp-control:${node.name}] Duty ${dutyText} observed, heating pair not moved`);
            } else if (heatEnableTransitions.length > 0) {
                const heatingTime = calculateHeatingTime(nowSec, heatEnableTransitions);
                const duty = calculateDuty(nowSec, true);
                dutyText = `${(duty * 100).toFixed(1)}% (${(heatingTime / 3600).toFixed(1)}h)`;
            }

            // Cooling setpoints stay the fixed UI values.
            const actualCoolSp1 = node.coolSpUpper;
            const actualCoolSp2 = node.coolSpLower;

            let heatSp1 = targetSp1 != null ? targetSp1 : 0;
            let heatSp2 = targetSp2 != null ? targetSp2 : 0;

            const modbusReady = heatSp1Actual != null && heatSp2Actual != null;
            if (!modbusReady) {
                return;
            }

            // Write ESTTW.2/.3 only when the recalc pair has moved by at least 1 C.
            // ESSWW.3 still hops between those two registers. HTSW.2 does not rewrite them.
            let pair = null;
            try {
                pair = node.context().global.get("hpSetpointPair");
            } catch (e) {
                pair = null;
            }
            if (pair && Number.isFinite(pair.hi) && Number.isFinite(pair.lo) && node.outHeatSp1Topic && node.outHeatSp2Topic) {
                let sp2Val = Math.round(pair.lo);
                let sp1Val = Math.round(pair.hi);
                sp2Val = Math.max(lo, Math.min(hi - 1, sp2Val));
                sp1Val = Math.max(sp2Val + 1, Math.min(hi, sp1Val));
                heatSp1 = sp1Val;
                heatSp2 = sp2Val;
                const commandedChanged =
                    heatSp1Written == null ||
                    heatSp2Written == null ||
                    Math.abs(sp1Val - heatSp1Written) >= 1 ||
                    Math.abs(sp2Val - heatSp2Written) >= 1;
                const alreadyThere = Math.abs(heatSp1Actual - sp1Val) < 1 && Math.abs(heatSp2Actual - sp2Val) < 1;
                if (commandedChanged && alreadyThere) {
                    heatSp1Written = sp1Val;
                    heatSp2Written = sp2Val;
                    targetSp1 = sp1Val;
                    targetSp2 = sp2Val;
                    node.log(`[hp-control:${node.name}] HP pair already ${sp1Val}/${sp2Val}, no write`);
                } else if (commandedChanged) {
                    const prev1 = heatSp1Actual;
                    const prev2 = heatSp2Actual;
                    const sp1Sent = sendChanged(node.outHeatSp1Topic, sp1Val);
                    const sp2Sent = sendChanged(node.outHeatSp2Topic, sp2Val);
                    if (sp1Sent || sp2Sent) {
                        if (sp1Sent) heatSp1Actual = sp1Val;
                        if (sp2Sent) heatSp2Actual = sp2Val;
                        heatSp1Written = sp1Val;
                        heatSp2Written = sp2Val;
                        lastSpWriteTs = nowSec;
                        targetSp1 = sp1Val;
                        targetSp2 = sp2Val;
                        saveState();
                        const cTxt = Number.isFinite(pair.center) ? pair.center.toFixed(1) : "n/a";
                        const qTxt = Number.isFinite(pair.qKw) ? pair.qKw.toFixed(1) : "n/a";
                        node.log(
                            `[hp-control:${node.name}] WRITE heating pair from recalc: SP1 ${Number(prev1).toFixed(1)} -> ${sp1Val} (${node.outHeatSp1Topic}), ` +
                                `SP2 ${Number(prev2).toFixed(1)} -> ${sp2Val} (${node.outHeatSp2Topic}) center=${cTxt}C Q=${qTxt}kW`
                        );
                    }
                }
            }

            // Write cooling setpoints at the same time (if not in heat-only mode)
            if (!heatSpOnly) {
                emitCoolSetpoints(nowSec, false);
            }

            // Monitor compressor stall and activate bump if needed
            monitorCompressorBump(nowSec);

            // Update all error bits
            updateErrorBits(nowSec);

            // Apply bump override via XOR: if bump active, toggle lowMode output
            // Gate by heatEnabled: low mode without a heat request makes no sense and
            // could cause the HP to run unnecessarily (flash wear + unwanted operation)
            const lowModeWithBump = testPwmActive ? (lowMode ? 1 : 0) : ((lowMode ? 1 : 0) ^ (bumpInProgress ? 1 : 0));
            const effectiveLowMode = heatEnabled ? lowModeWithBump : 0;
            sendChanged(node.outLowModeTopic, effectiveLowMode);

            const runReason = !enableCmd ? "OFF:cmd" : coolActive ? (forceCool ? "ON:force-cool" : "ON:cool") : forceHeat ? "ON:force-heat" : "ON:heat";
            const sp1Text = targetSp1 != null ? targetSp1.toFixed(1) : "n/a";
            const sp2Text = targetSp2 != null ? targetSp2.toFixed(1) : "n/a";
            const stateLogKey = `${runReason}|${lowMode}|${dutyText}|${sp1Text}|${sp2Text}|${adjustReason}|${heatEnabled}|${coolEnabled}`;
            if (node.logLevel !== "off" && stateLogKey !== prevStateLogKey) {
                node.log(`[hp-control:${node.name || "unnamed"}] state ` + `run=${runReason} low=${lowMode}${testPwmActive ? " pwm=" + node.testPwmDutyPct + "%" : ""} duty=${dutyText} target=${sp1Text}/${sp2Text}C adj=${adjustReason}`);
                prevStateLogKey = stateLogKey;
            }
            if (node.logLevel === "verbose") {
                const supplyStr = tankSetpoint != null ? `${Number(tankSetpoint).toFixed(2)}C` : "n/a";
                const autoCoolSuffix = autoCoolVerboseSuffix(coolActive);
                const verboseKey =
                    `${enableCmd}|${forceHeat}|${forceCool}|${heatEnabled}|${coolEnabled}|${Number(tankTemp).toFixed(2)}|${Number(target).toFixed(2)}|` +
                    `${heatErr.toFixed(2)}|${coolErr.toFixed(2)}|${tankRateCph.toFixed(1)}|${predictedErr.toFixed(2)}|${lowMode}|${dutyText}|${sp1Text}|${sp2Text}|${adjustReason}|` +
                    `${heatSp1.toFixed(2)}|${heatSp2.toFixed(2)}|${actualCoolSp1.toFixed(2)}|${actualCoolSp2.toFixed(2)}|${autoCoolSuffix}`;
                const due = nowSec - lastVerboseLogTs >= VERBOSE_MIN_LOG_SEC;
                if (verboseKey !== prevVerboseKey || due) {
                    node.log(
                        `[hp-control:${node.name || "unnamed"}] verbose ` +
                            `enable=${enableCmd} fHeat=${forceHeat} fCool=${forceCool} heatEn=${heatEnabled} coolEn=${coolEnabled} ` +
                            `tank=${Number(tankTemp).toFixed(2)} target=${Number(target).toFixed(2)} supplyT=${supplyStr} ` +
                            `hErr=${heatErr.toFixed(2)} cErr=${coolErr.toFixed(2)} ` +
                            `dTdt=${tankRateCph.toFixed(1)}C/h predErr=${predictedErr.toFixed(2)} ` +
                            `low=${lowMode} duty=${dutyText} targetSP=${sp1Text}/${sp2Text}C adj=${adjustReason} ` +
                            `spH1=${heatSp1.toFixed(2)} spH2=${heatSp2.toFixed(2)} spC1=${actualCoolSp1.toFixed(2)} spC2=${actualCoolSp2.toFixed(2)}` +
                            autoCoolSuffix
                    );
                    prevVerboseKey = verboseKey;
                    lastVerboseLogTs = nowSec;
                }
            }

            // Status display - don't override bump status or error states
            if (!bumpInProgress && !errorBitValues[ESMW_BIT_HP_NORUN]) {
                node.status({
                    fill: heatEnabled || coolEnabled ? "green" : "grey",
                    shape: "dot",
                    text: `${runReason} low=${lowMode ? 1 : 0}${testPwmActive ? " pwm=" + node.testPwmDutyPct + "%" : ""} duty=${dutyText} target=${sp1Text}/${sp2Text}C hErr=${heatErr.toFixed(1)} dTdt=${tankRateCph.toFixed(1)} predErr=${predictedErr.toFixed(1)}`
                });
            }
        }

        function validateAndCorrectSetpoints() {
            const nowSec = Math.floor(Date.now() / 1000);
            // Rate limit checks to every 5 minutes
            if (nowSec - lastSpCheckTs < SP_CHECK_INTERVAL_SEC) return;
            lastSpCheckTs = nowSec;

            // Don't correct while HP is disabled: setpoint mismatch is expected
            // (HP may clamp to its own minimum while off; we'll write on next enable).
            if (!heatEnabled && !coolEnabled) return;

            let needRewrite = false;
            let corruptionMsg = [];

            // Check heating setpoints
            if (
                heatSp1Written != null &&
                heatSp2Written != null &&
                heatSp1Actual != null &&
                heatSp2Actual != null &&
                Number.isFinite(heatSp1Written) &&
                Number.isFinite(heatSp2Written) &&
                Number.isFinite(heatSp1Actual) &&
                Number.isFinite(heatSp2Actual)
            ) {
                const sp1Diff = Math.abs(heatSp1Actual - heatSp1Written);
                const sp2Diff = Math.abs(heatSp2Actual - heatSp2Written);

                if (sp1Diff > SP_TOLERANCE_C || sp2Diff > SP_TOLERANCE_C) {
                    corruptionMsg.push(
                        `HEATING SP1: wrote ${heatSp1Written.toFixed(2)}C, HP reports ${heatSp1Actual.toFixed(2)}C (diff=${sp1Diff.toFixed(2)}C), ` +
                            `SP2: wrote ${heatSp2Written.toFixed(2)}C, HP reports ${heatSp2Actual.toFixed(2)}C (diff=${sp2Diff.toFixed(2)}C)`
                    );
                    needRewrite = true;
                }
            }

            // Check cooling setpoints
            if (
                coolSp1Written != null &&
                coolSp2Written != null &&
                coolSp1Actual != null &&
                coolSp2Actual != null &&
                Number.isFinite(coolSp1Written) &&
                Number.isFinite(coolSp2Written) &&
                Number.isFinite(coolSp1Actual) &&
                Number.isFinite(coolSp2Actual)
            ) {
                const sp1Diff = Math.abs(coolSp1Actual - coolSp1Written);
                const sp2Diff = Math.abs(coolSp2Actual - coolSp2Written);

                if (sp1Diff > SP_TOLERANCE_C || sp2Diff > SP_TOLERANCE_C) {
                    corruptionMsg.push(
                        `COOLING SP1: wrote ${coolSp1Written.toFixed(2)}C, HP reports ${coolSp1Actual.toFixed(2)}C (diff=${sp1Diff.toFixed(2)}C), ` +
                            `SP2: wrote ${coolSp2Written.toFixed(2)}C, HP reports ${coolSp2Actual.toFixed(2)}C (diff=${sp2Diff.toFixed(2)}C)`
                    );
                    needRewrite = true;
                }
            }

            if (needRewrite) {
                node.warn(`[hp-control:${node.name}] Setpoint readback off by >= 1 C: ${corruptionMsg.join("; ")} -- heating pair is not rewritten from readback`);

                // DON'T update targetSp1/targetSp2 here - they should only change via duty adjustments
                // The corruption correction will just rewrite the current target values

                // Do not rewrite here. compute() corrects a >= 1 C miss at most once per 12 h.
                // Forcing a write on every readback is what wore the HP flash.
            }
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();

            if (!biasInitialized && node.outHeatSp1Topic && t === node.outHeatSp1Topic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v === null) return;
                lastSent[t] = v; // seed dedup with actual HP value
                initSp1 = v;
                tryInitBias();
                return;
            }
            // Monitor actual setpoints read back from HP via read node (not loopback from our own output).
            // Seeding lastSent here prevents writing back the same value that the HP already holds,
            // even when emitCoolSetpoints/emitHeatSetpoints is called with skipIntervalCheck=true.
            if (node.outHeatSp1Topic && t === node.outHeatSp1Topic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) {
                    heatSp1Actual = v;
                    // Do not copy the readback into lastSent. That made every poll look like a new command.
                }
                return;
            }
            if (node.outHeatSp2Topic && t === node.outHeatSp2Topic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) {
                    heatSp2Actual = v;
                    validateAndCorrectSetpoints();
                }
                return;
            }
            if (node.outCoolSp1Topic && t === node.outCoolSp1Topic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) {
                    coolSp1Actual = v;
                    validateAndCorrectSetpoints();
                }
                return;
            }
            if (node.outCoolSp2Topic && t === node.outCoolSp2Topic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) {
                    coolSp2Actual = v;
                    validateAndCorrectSetpoints();
                }
                return;
            }
            // ESSWW feedback: when read-data-streams reports back what the iolayer currently holds,
            // sync lastSent so sendChanged detects any mismatch and corrects it on next compute().
            // This recovers from iolayer resets where hp-control's lastSent is stale vs iolayer state.
            if (node.outHeatEnableTopic && t === node.outHeatEnableTopic) {
                const bit = as01(msg.payload);
                if (bit === null) return;
                lastSent[t] = bit;
                compute(false, false);
                return;
            }
            if (node.outCoolEnableTopic && t === node.outCoolEnableTopic) {
                const bit = as01(msg.payload);
                if (bit === null) return;
                lastSent[t] = bit;
                compute(false, false);
                return;
            }
            if (node.outLowModeTopic && t === node.outLowModeTopic) {
                const bit = as01(msg.payload);
                if (bit === null) return;
                lastSent[t] = bit;
                compute(false, false);
                return;
            }
            // Auto-cooling: decision from room-overheat-checker
            if (node.coolingRequiredTopic && t === node.coolingRequiredTopic) {
                const bit = as01(msg.payload);
                if (bit === null) return;
                externalCoolingRequired = bit;
                compute(false, false);
                return;
            }
            if (node.spotPriceTopic && t === node.spotPriceTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) spotPrice = v;
                compute(false, false);
                return;
            }
            // HP bump monitoring inputs
            if (t === node.tankActualTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) tankActual = v;
                return;
            }
            if (t === node.compSpeedTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) compSpeed = v;
                return;
            }
            if (t === node.avgValveOpenTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) avgValveOpenness = v;
                return;
            }
            if (t === node.gasEnableTopic) {
                const bit = as01(msg.payload);
                gasEnabled = bit === null ? 0 : bit;
                return;
            }
            if (t === node.tankTempTopic) {
                const newTank = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (newTank === null) {
                    tankTemp = null;
                    failSafeDisable("unknown tank");
                    return;
                }
                updateDerivative(newTank, Math.floor(Date.now() / 1000));
                tankTemp = newTank;
            } else if (t === node.targetTopic) {
                target = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
            } else if (t === node.tankSetpointTopic) {
                const n = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (n === null) {
                    tankSetpoint = null;
                    return;
                }
                tankSetpoint = n;
                // Try to get P_max from mpc-house schedule context
                try {
                    const mpcHouseNodes = RED.nodes.getNode(node.z); // Get flow
                    if (mpcHouseNodes) {
                        // Search for mpc-house node in this flow
                        const flowNodes = RED.nodes.getFlowNodes(node.z);
                        const mpcNode = flowNodes.find((n) => n.type === "uniflex-mpc-house");
                        if (mpcNode) {
                            const schedule = RED.nodes.getNode(mpcNode.id).context().get("schedule");
                            if (schedule && schedule.P_max_12h != null) {
                                P_max_12h = schedule.P_max_12h;
                            }
                        }
                    }
                } catch (e) {
                    node.debug(`[hp-control:${node.name}] Could not fetch P_max from mpc-house: ${e.message}`);
                }

                // If P_max is still null and we don't have a persisted value, use a conservative default
                if (P_max_12h == null) {
                    P_max_12h = 10.0; // Default: 10 kW (reasonable for most heating scenarios)
                    node.debug(`[hp-control:${node.name}] Using default P_max_12h = ${P_max_12h} kW (mpc-house data not available yet)`);
                }

                // Save MPC values to persistence for restart resilience
                saveState();

                // Tank setpoint received from mpc-house -> recalculate and write HP setpoints immediately
                compute(false, true); // force setpoint write
                return; // Don't fall through to normal compute
            } else if (t === node.enableCmdTopic) {
                const bit = as01(msg.payload);
                enableCmd = bit === null ? 0 : bit;
            } else if (t === node.hcmwForceHeatTopic) {
                const bit = as01(msg.payload);
                forceHeat = bit === null ? 0 : bit;
            } else if (t === node.hcmwForceCoolTopic) {
                const bit = as01(msg.payload);
                forceCool = bit === null ? 0 : bit;
            } else if (t === node.spMinTopic) {
                spMinDyn = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
            } else if (t === node.spMaxTopic) {
                spMaxDyn = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
            } else return;
            compute(false, false);
            if (t === node.targetTopic || t === node.spMinTopic || t === node.spMaxTopic) {
                emitCoolSetpoints(Math.floor(Date.now() / 1000), false);
            }
        });

        // Load persistent state on startup
        const stateLoaded = loadState();
        if (!stateLoaded) {
            // No previous state, initialize lastBiasAdjustTs to now to wait 6h before first check
            lastBiasAdjustTs = Math.floor(Date.now() / 1000);
        }
        node.log(`[hp-control:${node.name}] *** VERSION ${NODE_VERSION} *** | HCMW forced/auto cool=${node.hcmwForceCoolTopic}`);

        // Periodic bump monitoring (check every 30 seconds even without new messages)
        const bumpCheckInterval = setInterval(() => {
            if (bumpInProgress || (compSpeed != null && compSpeed === 0)) {
                const nowSec = Math.floor(Date.now() / 1000);
                monitorCompressorBump(nowSec);
            }
        }, 30000); // 30 seconds

        // Save state on node close (restart, redeploy, or shutdown)
        node.on("close", (done) => {
            clearInterval(bumpCheckInterval);
            if (enableCmdWaitingLogTimer) {
                clearInterval(enableCmdWaitingLogTimer);
                enableCmdWaitingLogTimer = null;
            }
            node.log(`[hp-control:${node.name}] Shutting down, saving state...`);
            saveState();
            done();
        });
    }
    RED.nodes.registerType("uniflex-hp-control", HpControlNode);
};
