const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    const NODE_VERSION = "6.3.2-hcmw-ff"; // charge signal carries maxDeg for the HCMW feedforward
    const http = require("http");
    const fs = require("fs");
    const path = require("path");

    function MpcHouseNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        node.name = config.name || "";

        // Get thermal model from config node (or use fallback defaults)
        const thermalConfigNode = RED.nodes.getNode(config.thermalModel);
        let Cf, Ci, Uf, Uenv_base, k_wind, k_temp, Tbalance_model, Q_solar_max, Q_internal;
        let Qmax_hp, Qmax_gas, Q_distribution, Q_vent_max;
        let copT1, copV1, copT2, copV2, copNominal;
        let cop_a, cop_b, cop_c;
        let gas_efficiency;

        if (thermalConfigNode) {
            // Use values from thermal model config node
            Cf = thermalConfigNode.Cf;
            Ci = thermalConfigNode.Ci;
            Uf = thermalConfigNode.Uf;
            Uenv_base = thermalConfigNode.Uenv_base;
            k_wind = thermalConfigNode.k_wind;
            k_temp = thermalConfigNode.k_temp || 0.011;
            Tbalance_model = thermalConfigNode.Tbalance || 15;
            Q_solar_max = thermalConfigNode.Q_solar_max;
            Q_internal = thermalConfigNode.Q_internal || 0;
            Qmax_hp = thermalConfigNode.hp_Qmax;
            Qmax_gas = thermalConfigNode.gas_Qmax;
            Q_distribution = thermalConfigNode.Q_distribution;
            Q_vent_max = thermalConfigNode.Q_vent_max || 2.2;
            copT1 = thermalConfigNode.hp_copT1;
            copV1 = thermalConfigNode.hp_copV1;
            copT2 = thermalConfigNode.hp_copT2;
            copV2 = thermalConfigNode.hp_copV2;
            copNominal = copV2;
            cop_a = thermalConfigNode.cop_a || 0;
            cop_b = thermalConfigNode.cop_b || 0;
            cop_c = thermalConfigNode.cop_c || 0;
            gas_efficiency = thermalConfigNode.gas_efficiency;
            node.log(`[mpc-house:${node.name}] Using thermal model: ${thermalConfigNode.name}`);
        } else {
            // Fallback to defaults (for backward compatibility)
            Cf = 80.0;
            Ci = 43.3;
            Uf = 2.0;
            Uenv_base = 0.45;
            k_wind = 0.0211;
            k_temp = 0.011;
            Tbalance_model = 15;
            Q_solar_max = 7.09;
            Q_internal = 0.45 * (20 - 15); // 2.25 kW default
            Qmax_hp = 15.0;
            Qmax_gas = 28.0;
            Q_distribution = 22.0;
            Q_vent_max = 2.2;
            copT1 = -10;
            copV1 = 2.0;
            copT2 = 10;
            copV2 = 3.1;
            copNominal = copV2;
            cop_a = 0;
            cop_b = 0;
            cop_c = 0;
            gas_efficiency = 0.95;
            node.log(`[mpc-house:${node.name}] No thermal model config selected, using defaults`);
        }

        // Heating envelope time constant. Free cooling is a longer lag and is not used here.
        const heatLeadH = (Number.isFinite(Ci) && Ci > 0 && Number.isFinite(Uenv_base) && Uenv_base > 0) ? (Ci / Uenv_base) : 96;

        // Comfort & optimization (still configurable per node)
        const Tset = parseFloat(config.Tset) || 21.0;
        const bandLow = parseFloat(config.band_low) || 0.5;
        const bandHigh = parseFloat(config.band_high) || 0.7;
        const horizonHours = parseInt(config.horizon) || 24;

        // Control interval: 60 = 1 hour, 15 = 15 minutes
        const controlIntervalMinutes = parseInt(config.controlInterval) || 60;
        const slotDuration = controlIntervalMinutes * 60; // seconds per slot
        const slotsPerHour = Math.round(3600 / slotDuration);
        const totalSlots = horizonHours * slotsPerHour;

        // Minimum HP block in slots (prevents short cycling)
        // Default: 2 slots (30 min for 15-min interval, 2h for 1h interval)
        const minBlock = Math.max(1, parseInt(config.minBlock) || 2);

        // Price step (minutes) for two-run scheduling: 0 = use control interval; 15 = base 15-min steps
        const priceStepMinutes = Math.max(0, parseInt(config.priceStepMinutes) || 0);
        // Source preference smoothing (reduce noisy HP/GAS flips on tiny price deltas)
        const hpGasDeadbandEurPerKwh = Number.isFinite(parseFloat(config.hpGasDeadbandEurPerKwh)) ? Math.max(0, parseFloat(config.hpGasDeadbandEurPerKwh)) : 0.003;
        const hpGasSwitchPenaltyEurPerKwh = Number.isFinite(parseFloat(config.hpGasSwitchPenaltyEurPerKwh)) ? Math.max(0, parseFloat(config.hpGasSwitchPenaltyEurPerKwh)) : 0.006;
        const hpGasLookaheadMin = Number.isFinite(parseInt(config.hpGasLookaheadMin)) ? Math.max(15, parseInt(config.hpGasLookaheadMin)) : 60;

        // Price-based charge signal: max degC adjustment sent to rooms
        const chargeMaxDeg = Number.isFinite(parseFloat(config.chargeMaxDeg)) ? Math.max(0, parseFloat(config.chargeMaxDeg)) : 3.0;
        // How much of chargeAdj[0] to apply to the HP supply target (degC per chargeMaxDeg)
        // Default: same scale as floor adjustment, so HP supply rises/falls in sync with floors
        const supplyChargeEnabled = config.supplyChargeEnabled !== false; // default true

        // Adaptive feedback (optional)
        const enableAdaptiveFeedback = config.enableAdaptiveFeedback !== false; // default true
        const modelErrorThreshold = parseFloat(config.modelErrorThreshold) || 1.0; // degC
        const adaptiveBandRate = parseFloat(config.adaptiveBandRate) || 0.05; // per occurrence
        const maxBandAdjustment = parseFloat(config.maxBandAdjustment) || 0.3; // degC

        // Logging & validation
        const enableLogging = config.enableLogging !== false; // default true
        const verifyOutputs = config.verifyOutputs === true; // default false
        const log = (msg) => {
            if (enableLogging) node.log(msg);
        };
        // Use node.log (info), not node.debug -- some runtimes log debug as [error] in journald
        const debug = (msg) => {
            if (enableLogging) node.log(msg);
        };

        // Input topics
        const tiTopic = config.tiTopic || "";
        const tfTopic = config.tfTopic || "";
        const tsetAvgTopic = config.tsetAvgTopic || "";
        const triggerTopic = config.triggerTopic || "heating/tick";
        const fullRecalcTopic = config.fullRecalcTopic || "heating/mpc/recalc";
        const qFloorActualTopic = config.qFloorActualTopic || "";
        const qAirActualTopic = config.qAirActualTopic || "";
        const avavwTopic = (config.avavwTopic || "AVAVW").trim(); // valve openness: .1=avg%, .2=threshold%

        // Adjustment threshold - only adjust current hour if deviation exceeds this
        const adjustmentThreshold = parseFloat(config.adjustmentThreshold) || 1.0; // degC

        // Output datastreams (to iolayer) - leave empty to disable
        const outTempTopic = config.outTempTopic || ""; // 5 members: Ti, Ti_pred, Tset, Tmin, Tmax
        const outPowerTopic = config.outPowerTopic || ""; // 2 members: Q_plan_total, Q_actual_total
        const outControlTopic = config.outControlTopic || ""; // 2 members: heat_allowed, efficiency
        const outErrorTopic = config.outErrorTopic || ""; // 3 members: model_err, band_low_adj, band_high_adj
        const outUnitlessTopic = config.outUnitlessTopic || ""; // 8 members: mode/ratios/weights/flags
        const outFlagsTopic = config.outFlagsTopic || ""; // 8 members: MPCGW boolean freeze/gate flags (last reserved)
        const outLearningAgeTopic = config.outLearningAgeTopic || ""; // MPCLV scalar: seconds since last learning apply
        const outQualityTopic = config.outQualityTopic || ""; // MPCZV scalar: learning data quality (0..100%)
        const autotuneMode = (config.autotuneMode || "shadow").toLowerCase(); // off|shadow|active
        const autotuneModeCode = autotuneMode === "active" ? 2 : autotuneMode === "shadow" ? 1 : 0;

        // Calendar (read + write)
        const priceTitleElec = config.priceTitleElec || "heat_prc_ele";
        const priceTitleGas = config.priceTitleGas || "heat_prc_gas";
        const hpScheduleTitle = config.hpScheduleTitle || "hp_ena";
        const gasScheduleTitle = config.gasScheduleTitle || "gas_ena";
        const planHeatTitle = (config.planHeatTitle || "plan_heat").trim();
        const planElecTitle = (config.planElecTitle || "plan_elec").trim();
        const calendarTopic = config.calendarTopic || "calendar/mpc";
        const tempTitle = config.tempTitle || "main_temp";
        const windTitle = config.windTitle || "wind_speed";

        // Calendar API (uses HTTP like other nodes)
        const calendarHost = config.calendarHost || "localhost";
        const calendarPort = parseInt(config.calendarPort) || 80;
        // Prefer global.forecastCache for outdoor temp & wind (same source as mpc-room-advanced); avoids duplicate calendar HTTP for Tout/wind
        const useForecastCache = config.useForecastCache !== false;
        const FORECAST_CACHE_MAX_AGE_MS = 14 * 3600 * 1000; // same window as mpc-room-advanced, so the 96 h date mean is still there at both recalcs

        // Calendar HTTP: limit JSON size (prevents OOM on ARM) and lookback (15-min x 30d was huge)
        const calendarLookbackDays = Math.max(1, Math.min(62, parseInt(config.calendarLookbackDays, 10) || 10));
        const calendarMaxResponseMB = Math.max(1, Math.min(64, Number(config.calendarMaxResponseMB) || 6));
        const CALENDAR_MAX_RESPONSE_BYTES = Math.floor(calendarMaxResponseMB * 1024 * 1024);
        const CALENDAR_LOOKBACK_SEC = calendarLookbackDays * 24 * 3600;

        // HP Power Control
        const supplyTargetTopic = (config.supplyTargetTopic || "").trim();
        const totalRoomLoadTopic = config.totalRoomLoadTopic || "";
        const hpSetpointHilim = config.hpSetpointHilim != null && config.hpSetpointHilim !== "" ? parseFloat(config.hpSetpointHilim) : null;
        const hpSetpointLolim = config.hpSetpointLolim != null && config.hpSetpointLolim !== "" ? parseFloat(config.hpSetpointLolim) : null;

        // Schedule change notification -- publish when schedule is rewritten with a different pattern
        const scheduleChangedOutTopic = (config.scheduleChangedOutTopic || "").trim();

        // Persistence: save/restore adaptive state across Node-RED restarts
        const persistencePath = (config.persistencePath || "").trim();
        const persistenceFile = (() => {
            if (!persistencePath) return null;
            const pfx = "mpc-house";
            const safe = (node.name || node.id).replace(/\s+/g, "-");
            const stem = safe === pfx || safe.startsWith(pfx + "-") ? safe : `${pfx}-${safe}`;
            return path.join(persistencePath, `${stem}.json`);
        })();

        // Fetcher trigger topics: used when calendar is stale after long downtime
        const priceFetcherTopic = (config.priceFetcherTopic || "").trim();
        const gasPriceFetcherTopic = (config.gasPriceFetcherTopic || "").trim();
        const weatherFetcherTopic = (config.weatherFetcherTopic || "").trim();

        // State (from topics)
        let Ti = null;
        let Tf = null;
        let TsetFromTopic = null; // Average setpoint from iolayer
        let lastSupplyTarget = null;
        let avgValveOpenness = null; // AVAVW.1: avg valve openness %
        let valveGateThreshold = null; // AVAVW.2: gate threshold %
        let lastTout = null; // Tout[0] from last optimizeSchedule run
        let lastTsetUsed = null; // TsetUsed from last optimizeSchedule run

        // Model validation state
        let Ti_pred_last = null; // Predicted Ti for validation
        let timestamp_last = null; // When prediction was made
        let bandLowAdjustment = 0.0; // Adaptive adjustment
        let bandHighAdjustment = 0.0; // Adaptive adjustment
        const modelErrorHistory = []; // Last N errors for analytics
        const MAX_ERROR_HISTORY = 24; // Store 24 hours

        // Power feedback state
        let Q_floor_actual = null; // Current floor heating power (kW)
        let Q_air_actual = null; // Current air heating power (kW)
        // Energy taken during the current HP block. Used to extend the block when the floors
        // deliver less than the plan. Cleared on a full recalc.
        let heatAccount = null;
        let closedBlockStartTs = 0;
        let Q_planned_last = null; // Last planned Q for current hour
        let totalRoomLoad = null; // Total room load (kW) from topic, when HP Power Control input is used
        let warnedTfInvalid = false; // Warn once when Tf topic is configured but payload is invalid/missing

        // Demand learning: tracks actual vs planned heat and builds a long-run scale factor.
        let demandScale = 1.0; // Learned multiplier applied to Q_demand before allocation
        const DEMAND_LEARN_MAX_SLOTS = 48; // Rolling 48-hour window (1 entry per hourly tick)
        const demandLearningBuffer = []; // [{E_actual, E_planned}] -- instantaneous kW, one per tick
        let lastTickRunTime = 0; // Throttle tick-driven runs (and thus all outputs) to at most once per TICK_RUN_THROTTLE_MS
        const TICK_RUN_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes -- cache inputs; only run/publish on tick when throttle allows
        // Learning stale freeze flag is evaluated on real MPC runs and held between publish-only ticks.
        let staleDataFreezeState = 0;
        // Trend tracking for predictive tick decisions (avoid purely reactive threshold gate).
        let tiTrendSlopeCph = 0; // EMA slope in degC/hour
        let tiTrendLastVal = null;
        let tiTrendLastTs = null;
        const TI_TREND_MIN_DT_SEC = 60;
        const TI_TREND_MAX_DT_SEC = 3 * 3600;
        const TI_TREND_EMA_ALPHA = 0.25;
        // Slow system: use longer trend projection than reactive short-term tick.
        // Default horizon is 24h -> lookahead 6h; clamp avoids extremes on custom horizons.
        const TI_TREND_LOOKAHEAD_H = Math.max(3, Math.min(8, horizonHours * 0.25));
        const TI_TREND_MIN_ABS_SLOPE_CPH = 0.08;
        const nodeContext = node.context();
        const autotuneStoreRaw = nodeContext.get("autotuneStore") || {};
        const ensureBankState = (bankName) => {
            const bank = autotuneStoreRaw[bankName] || {};
            return {
                errorHistory: Array.isArray(bank.errorHistory) ? bank.errorHistory : [],
                lastApplySec: Number.isFinite(bank.lastApplySec) ? bank.lastApplySec : null
            };
        };
        const legacyLastApplyRaw = nodeContext.get("lastLearningApplySec");
        autotuneStoreRaw.heat = ensureBankState("heat");
        autotuneStoreRaw.cool = ensureBankState("cool");
        autotuneStoreRaw.lastBank = autotuneStoreRaw.lastBank === "cool" || autotuneStoreRaw.lastBank === "heat" ? autotuneStoreRaw.lastBank : "heat";
        if (Number.isFinite(legacyLastApplyRaw) && !Number.isFinite(autotuneStoreRaw.heat.lastApplySec)) {
            autotuneStoreRaw.heat.lastApplySec = legacyLastApplyRaw;
        }
        const getLearningAgeSec = (nowSec, lastApplySec) => (Number.isFinite(lastApplySec) ? Math.max(0, Math.floor(nowSec - lastApplySec)) : 0);
        const selectAutotuneBank = (qPlanned, prevBank) => {
            if (Number.isFinite(qPlanned) && qPlanned < -0.01) return "cool";
            if (Number.isFinite(qPlanned) && qPlanned > 0.01) return "heat";
            return prevBank === "cool" ? "cool" : "heat";
        };
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const getErrorRatios = (history) => {
            const n = history.length;
            if (n <= 0) return { underRatio: 0, overRatio: 0, samples: 0 };
            let under = 0;
            let over = 0;
            for (const e of history) {
                if (e.error <= -modelErrorThreshold) under++;
                if (e.error >= modelErrorThreshold) over++;
            }
            return { underRatio: under / n, overRatio: over / n, samples: n };
        };

        // Time step for thermal simulation (in hours) - matches slot duration
        const dt = slotDuration / 3600; // hours per slot

        node.status({ fill: "grey", shape: "dot", text: "Waiting for data..." });

        // Log startup info with version (always shows)
        const modelName = thermalConfigNode ? thermalConfigNode.name : "(defaults)";
        node.log(
            `[mpc-house:${node.name}] *** VERSION ${NODE_VERSION} *** | ` +
                `model: ${modelName} | Cf=${Cf} Ci=${Ci} Uf=${Uf} Uenv=${Uenv_base} k_temp=${k_temp} Q_int=${Q_internal.toFixed(2)}kW | ` +
                `COP_plane=${cop_a > 0 ? `${cop_a}+${cop_b}*T+${cop_c}*P` : "off"} | ` +
                `comfort: Tset=${Tset} bands=[${bandLow},${bandHigh}] | horizon=${horizonHours}h (${totalSlots} slots @ ${controlIntervalMinutes}min) | ` +
                `sources: HP=${Qmax_hp}kW gas=${Qmax_gas}kW | dist=${Q_distribution}kW (floor=${(Q_distribution - Q_vent_max).toFixed(1)}+vent=${Q_vent_max}kW) | chargeMax=${chargeMaxDeg}degC`
        );
        node.log(
            `[mpc-house:${node.name}] autotune mode=${autotuneMode} | ` +
                `telemetry: unitless=${outUnitlessTopic || "-"} flags=${outFlagsTopic || "-"} ` +
                `learningAge=${outLearningAgeTopic || "-"} quality=${outQualityTopic || "-"}`
        );
        node.log(`[mpc-house:${node.name}] autotune banks enabled: auto-switch heat/cool by planned demand sign`);
        node.log(
            `[mpc-house:${node.name}] calendar HTTP: lookback=${calendarLookbackDays}d maxBody=${calendarMaxResponseMB}MB | ` + `forecastCache=${useForecastCache ? "on" : "off"}`
        );

        // Validate output datastreams on startup by querying controller config
        const outputConfigs = [
            { topic: outTempTopic, name: "Temp", members: 5 },
            { topic: outPowerTopic, name: "Power", members: 2 },
            { topic: outControlTopic, name: "Control", members: 2 },
            { topic: outErrorTopic, name: "Error", members: 3 },
            { topic: outUnitlessTopic, name: "Unitless", members: 8 },
            { topic: outFlagsTopic, name: "Flags", members: 8 },
            { topic: outLearningAgeTopic, name: "LearningAge", members: 1 },
            { topic: outQualityTopic, name: "Quality", members: 1 }
        ];
        const configuredOutputs = outputConfigs.filter((cfg) => cfg.topic);

        // Output verification (optional - datastreams may not exist until first value is sent)
        if (configuredOutputs.length > 0) {
            if (verifyOutputs) {
                // Delay validation to allow other nodes to initialize
                setTimeout(() => {
                    // Query controller config to get known write topics
                    let adminRoot = RED.settings.httpAdminRoot || "";
                    // Ensure proper path format (no double slashes)
                    if (adminRoot && !adminRoot.endsWith("/")) adminRoot += "/";
                    if (!adminRoot) adminRoot = "/";
                    const path = `${adminRoot}uniflex/controller-config`;
                    const req = http.request(
                        {
                            hostname: "127.0.0.1",
                            port: RED.settings.uiPort || 1880,
                            path: path,
                            method: "GET"
                        },
                        (res) => {
                            let data = "";
                            res.on("data", (chunk) => {
                                data += chunk;
                            });
                            res.on("end", () => {
                                if (res.statusCode !== 200) {
                                    node.warn(`[mpc-house:${node.name}] Controller config HTTP ${res.statusCode} - path: ${path}`);
                                    return;
                                }
                                try {
                                    const config = JSON.parse(data);
                                    const knownWriteTopics = new Set();

                                    // Extract writable topic keys from controller's writableServices
                                    const controllers = config?.controllers || [];
                                    controllers.forEach((c) => {
                                        // writableServices is an object: { "TOPIC": [1, 2, 3], ... }
                                        if (c.writableServices) {
                                            Object.keys(c.writableServices).forEach((key) => {
                                                knownWriteTopics.add(key);
                                            });
                                        }
                                    });

                                    // Uses controller writableServices (same member rules as write-data-streams / iolayer).
                                    // Topics only on send-data-streams are still valid; this check may miss edge configs.
                                    if (knownWriteTopics.size > 0) {
                                        const found = configuredOutputs.filter((cfg) => knownWriteTopics.has(cfg.topic));
                                        const missing = configuredOutputs.filter((cfg) => !knownWriteTopics.has(cfg.topic));
                                        if (found.length > 0) {
                                            log(`[mpc-house:${node.name}] Outputs verified in iolayer: ${found.map((c) => `${c.topic}(.1-.${c.members})`).join(", ")}`);
                                        }
                                        if (missing.length > 0) {
                                            // Just debug, not error - topics may be in send-data-streams node
                                            debug(
                                                `[mpc-house:${node.name}] Outputs not in controller writableServices (may be in send-data-streams): ${missing.map((c) => c.topic).join(", ")}`
                                            );
                                        }
                                    } else {
                                        debug(
                                            `[mpc-house:${node.name}] Outputs: ${configuredOutputs.map((c) => `${c.topic}(.1-.${c.members})`).join(", ")} (no writableServices in controller to verify against)`
                                        );
                                    }
                                } catch (e) {
                                    debug(`[mpc-house:${node.name}] Controller config parse error: ${e.message}`);
                                }
                            });
                        }
                    );
                    req.on("error", (e) => {
                        debug(`[mpc-house:${node.name}] Controller config query failed: ${e.message}`);
                    });
                    req.end();
                }, 3000); // Wait 3s for other nodes to fully initialize
            } else {
                debug(`[mpc-house:${node.name}] Outputs configured: ${configuredOutputs.map((c) => `${c.topic}(.1-.${c.members})`).join(", ")} (verification disabled)`);
            }
        }

        const deployTickTimer = setTimeout(async () => {
            // Step 1: Restore adaptive state from persistence file
            loadState();

            // Step 2: Try to reconstruct schedule from existing calendar events (avoids full recalc on NR restart)
            const restored = await restoreScheduleFromCalendar();
            if (restored) return; // chargeSignal is already in global context, schedule in nodeContext

            // Step 3: No future schedule found -- check if calendar data is available for a fresh recalc
            await checkAndTriggerFetchers();
        }, 60000);
        node.on("close", function () {
            clearTimeout(deployTickTimer);
            saveState();
        });

        // ------------------------------------------------------------------
        // Persistence helpers
        // ------------------------------------------------------------------

        function saveState() {
            if (!persistenceFile) return;
            try {
                const data = {
                    savedAt: Date.now(),
                    bandLowAdjustment,
                    bandHighAdjustment,
                    Ti_pred_last,
                    timestamp_last,
                    autotuneStoreRaw: nodeContext.get("autotuneStore") || autotuneStoreRaw,
                    chargeSignal: nodeContext.global.get("chargeSignal") || null,
                    lastScheduleSig: nodeContext.get("lastScheduleSig") || null,
                    demandScale,
                    demandLearningBuffer: demandLearningBuffer.slice(-DEMAND_LEARN_MAX_SLOTS)
                };
                fs.writeFileSync(persistenceFile, JSON.stringify(data, null, 2), "utf8");
                debug(`[mpc-house:${node.name}] State saved (bandLow=${bandLowAdjustment.toFixed(2)}, bandHigh=${bandHighAdjustment.toFixed(2)})`);
            } catch (e) {
                node.error(`[mpc-house:${node.name}] Failed to save state: ${e.message}`);
            }
        }

        function loadState() {
            if (!persistenceFile) return false;
            try {
                const data = JSON.parse(fs.readFileSync(persistenceFile, "utf8"));
                if (Number.isFinite(data.bandLowAdjustment)) bandLowAdjustment = data.bandLowAdjustment;
                if (Number.isFinite(data.bandHighAdjustment)) bandHighAdjustment = data.bandHighAdjustment;
                if (Number.isFinite(data.Ti_pred_last)) Ti_pred_last = data.Ti_pred_last;
                if (Number.isFinite(data.timestamp_last)) timestamp_last = data.timestamp_last;
                if (data.autotuneStoreRaw && typeof data.autotuneStoreRaw === "object") {
                    Object.assign(autotuneStoreRaw, data.autotuneStoreRaw);
                    nodeContext.set("autotuneStore", autotuneStoreRaw);
                }
                if (data.chargeSignal && Array.isArray(data.chargeSignal.adj)) {
                    nodeContext.global.set("chargeSignal", data.chargeSignal);
                }
                if (data.lastScheduleSig) {
                    nodeContext.set("lastScheduleSig", data.lastScheduleSig);
                }
                if (Number.isFinite(data.demandScale) && data.demandScale > 0) demandScale = data.demandScale;
                if (Array.isArray(data.demandLearningBuffer)) {
                    for (const e of data.demandLearningBuffer.slice(-DEMAND_LEARN_MAX_SLOTS)) {
                        if (Number.isFinite(e.E_actual) && Number.isFinite(e.E_planned) && e.E_planned > 0) {
                            demandLearningBuffer.push(e);
                        }
                    }
                }
                const ageMins = ((Date.now() - (data.savedAt || 0)) / 60000).toFixed(0);
                log(`[mpc-house:${node.name}] State loaded (age=${ageMins}min, bandLow=${bandLowAdjustment.toFixed(2)}, bandHigh=${bandHighAdjustment.toFixed(2)})`);
                return true;
            } catch (e) {
                debug(`[mpc-house:${node.name}] No previous state or unreadable: ${e.message}`);
                return false;
            }
        }

        // Fetch raw calendar events (with ts1/ts2 start/end times) for schedule reconstruction.
        // Uses events=true parameter which returns [{title, ts1, ts2, value, mid}, ...].
        function queryCalendarEventsRaw(title, startTs, endTs) {
            return new Promise((resolve) => {
                const queryParams = new URLSearchParams({
                    title,
                    start: startTs.toString(),
                    end: endTs.toString(),
                    events: "true"
                });
                const req = http.request(
                    {
                        hostname: calendarHost,
                        port: calendarPort,
                        path: `/calendar?${queryParams.toString()}`,
                        method: "GET",
                        timeout: 8000
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (chunk) => {
                            data += chunk;
                        });
                        res.on("end", () => {
                            try {
                                const parsed = JSON.parse(data);
                                resolve(Array.isArray(parsed) ? parsed : []);
                            } catch (e) {
                                resolve([]);
                            }
                        });
                    }
                );
                req.on("error", () => resolve([]));
                req.on("timeout", () => {
                    req.destroy();
                    resolve([]);
                });
                req.end();
            });
        }

        // Reconstruct a minimal schedule from existing calendar events after a Node-RED restart.
        // Returns true if a usable schedule was found and restored, false if a full recalc is needed.
        async function restoreScheduleFromCalendar() {
            const now = Math.floor(Date.now() / 1000);
            const baseSlot = Math.floor(now / slotDuration) * slotDuration;
            const horizon = baseSlot + totalSlots * slotDuration;

            // Look back 24h to catch any ongoing event that started before now
            const hpEvts = await queryCalendarEventsRaw(hpScheduleTitle, now - 24 * 3600, horizon);
            const gasEvts = await queryCalendarEventsRaw(gasScheduleTitle, now - 24 * 3600, horizon);

            const futHp = hpEvts.filter((e) => e.ts2 > baseSlot && e.ts1 < horizon);
            const futGas = gasEvts.filter((e) => e.ts2 > baseSlot && e.ts1 < horizon);

            if (futHp.length === 0 && futGas.length === 0) {
                debug(`[mpc-house:${node.name}] No future HP/gas events in calendar -- full recalc needed`);
                return false;
            }

            const hp_ena = new Array(totalSlots).fill(0);
            const gas_ena = new Array(totalSlots).fill(0);

            let avgPowerHp = 0;
            for (const evt of futHp) {
                const m = String(evt.value || "").match(/\((\d+\.?\d*)\s*kW\)/);
                if (m) avgPowerHp = Math.max(avgPowerHp, parseFloat(m[1]));
                const sStart = Math.max(0, Math.ceil((evt.ts1 - baseSlot) / slotDuration));
                const sEnd = Math.min(totalSlots, Math.ceil((evt.ts2 - baseSlot) / slotDuration));
                for (let s = sStart; s < sEnd; s++) hp_ena[s] = 1;
            }
            if (avgPowerHp <= 0) avgPowerHp = Qmax_hp * 0.7;

            let avgPowerGas = 0;
            for (const evt of futGas) {
                const m = String(evt.value || "").match(/\((\d+\.?\d*)\s*kW\)/);
                if (m) avgPowerGas = Math.max(avgPowerGas, parseFloat(m[1]));
                const sStart = Math.max(0, Math.ceil((evt.ts1 - baseSlot) / slotDuration));
                const sEnd = Math.min(totalSlots, Math.ceil((evt.ts2 - baseSlot) / slotDuration));
                for (let s = sStart; s < sEnd; s++) gas_ena[s] = 1;
            }
            if (avgPowerGas <= 0 && Qmax_gas) avgPowerGas = Qmax_gas * 0.7;

            const Q = hp_ena.map((h, i) => (h ? avgPowerHp : gas_ena[i] ? avgPowerGas : 0));
            const hpHours = ((hp_ena.filter((v) => v === 1).length * slotDuration) / 3600).toFixed(1);
            const gasHours = ((gas_ena.filter((v) => v === 1).length * slotDuration) / 3600).toFixed(1);
            const P_max_12h_est = Math.max(0, ...Q.slice(0, Math.min(24, Q.length)));

            const schedule = {
                baseSlot,
                slotDurationUsed: slotDuration,
                Q,
                allow: Q.map((q) => (q > 0 ? 1 : 0)),
                hp_ena,
                gas_ena,
                Tf_pred: [],
                Ti_pred: [],
                Tmin: null,
                Tmax: null,
                Tset: null,
                Ti_now: null,
                Tf_now: null,
                timestamp: Date.now(),
                bandLowEffective: bandLow + bandLowAdjustment,
                bandHighEffective: bandHigh + bandHighAdjustment,
                bandLowAdjustment,
                bandHighAdjustment,
                P_max_12h: P_max_12h_est,
                restoredFromCalendar: true
            };

            nodeContext.set("schedule", schedule);
            log(`[mpc-house:${node.name}] Schedule RESTORED from calendar: HP=${hpHours}h gas=${gasHours}h avgQ=${avgPowerHp.toFixed(1)}kW -- skipping full recalc`);
            node.status({ fill: "blue", shape: "dot", text: `Restored HP=${hpHours}h` });
            return true;
        }

        // Check if critical calendar data (prices, weather) is present for MPC.
        // Triggers configured fetcher nodes for any missing series, then schedules a delayed recalc.
        async function checkAndTriggerFetchers() {
            const checkSlots = Math.min(8, totalSlots); // check next ~4h

            const priceArr = await new Promise((r) => queryCalendarSeries(priceTitleElec, NaN, r));
            const hasPrices = priceArr.slice(0, checkSlots).filter((v) => Number.isFinite(v) && v > 0).length >= 2;

            let hasWeather = true;
            if (tempTitle) {
                const tempArr = await new Promise((r) => queryCalendarSeries(tempTitle, NaN, r));
                hasWeather = tempArr.slice(0, checkSlots).filter((v) => Number.isFinite(v)).length >= 2;
            }

            let hasGasPrices = true;
            if (priceTitleGas) {
                const gasArr = await new Promise((r) => queryCalendarSeries(priceTitleGas, NaN, r));
                hasGasPrices = gasArr.slice(0, checkSlots).filter((v) => Number.isFinite(v) && v > 0).length >= 2;
            }

            const triggeredList = [];
            if (!hasPrices && priceFetcherTopic) {
                node.send({ topic: priceFetcherTopic, payload: 1 });
                triggeredList.push("elec-prices");
            }
            if (!hasGasPrices && gasPriceFetcherTopic) {
                node.send({ topic: gasPriceFetcherTopic, payload: 1 });
                triggeredList.push("gas-prices");
            }
            if (!hasWeather && weatherFetcherTopic) {
                node.send({ topic: weatherFetcherTopic, payload: 1 });
                triggeredList.push("weather");
            }

            if (triggeredList.length > 0) {
                log(`[mpc-house:${node.name}] Missing calendar data (${triggeredList.join(", ")}) -- triggered fetchers, recalc in 3 min`);
                node.status({ fill: "yellow", shape: "ring", text: `Fetching: ${triggeredList.join("+")}` });
                const delayedTimer = setTimeout(
                    () => {
                        log(`[mpc-house:${node.name}] Running delayed post-fetch full recalc`);
                        node.receive({ topic: fullRecalcTopic, payload: 1 });
                    },
                    3 * 60 * 1000
                );
                node.on("close", () => clearTimeout(delayedTimer));
            } else if (!hasPrices || !hasWeather || !hasGasPrices) {
                const missing = [!hasPrices && "elec-prices", !hasWeather && "weather", !hasGasPrices && "gas-prices"].filter(Boolean);
                log(`[mpc-house:${node.name}] Missing calendar data (${missing.join(", ")}) but no fetcher topics configured -- waiting for scheduled recalc`);
            } else {
                log(`[mpc-house:${node.name}] Calendar data present but no schedule -- triggering full recalc`);
                node.receive({ topic: fullRecalcTopic, payload: 1 });
            }
        }

        // ======================================================================
        // THERMAL MODEL
        // ======================================================================

        function step(Tf, Ti, Tout, Q, wind) {
            const Uenv_eff = Uenv_base + k_temp * Math.max(0, Tbalance_model - Tout) + k_wind * wind;
            const Q_solar = 0;

            // Split heating: ventilation heats air directly, rest goes through floor
            const Q_air_direct = Math.min(Q_vent_max, Q);
            const Q_floor = Q - Q_air_direct;

            const dTf = (1.0 / Cf) * Q_floor - (Uf / Cf) * (Tf - Ti);
            const Tf_next = Tf + dTf * dt;

            const dTi = (Uf / Ci) * (Tf - Ti) + (Uenv_eff / Ci) * (Tout - Ti) + (1.0 / Ci) * (Q_solar + Q_internal + Q_air_direct);
            const Ti_next = Ti + dTi * dt;

            return { Tf: Tf_next, Ti: Ti_next };
        }

        function simulate(Tf0, Ti0, ToutArr, windArr, QArr) {
            let Tf = Tf0;
            let Ti = Ti0;
            const Tf_pred = [];
            const Ti_pred = [];
            let minT = Infinity;
            let maxT = -Infinity;

            for (let k = 0; k < QArr.length; k++) {
                const result = step(Tf, Ti, ToutArr[k], QArr[k], windArr[k]);
                Tf = result.Tf;
                Ti = result.Ti;
                Tf_pred.push(Tf);
                Ti_pred.push(Ti);
                if (Ti < minT) minT = Ti;
                if (Ti > maxT) maxT = Ti;
            }
            return { Tf_pred, Ti_pred, minT, maxT };
        }

        // ======================================================================
        // COP INTERPOLATION & HP CAPACITY
        // ======================================================================

        // COP model: plane (preferred) or linear fallback
        function getCopAtTemp(Tout, Power) {
            if (cop_a > 0 && Power != null) {
                return Math.max(1.0, cop_a + cop_b * Tout + cop_c * Power);
            }
            if (copT1 === copT2) return copV1;
            const slope = (copV2 - copV1) / (copT2 - copT1);
            return Math.max(1.0, copV1 + slope * (Tout - copT1));
        }

        // HP capacity derated by COP at nominal power
        function getHpCapacityAtTemp(Tout) {
            const copAtNom = getCopAtTemp(Tout, Qmax_hp);
            const derateFactor = copAtNom / copNominal;
            return Qmax_hp * Math.min(1.0, derateFactor);
        }

        // ======================================================================
        // CALENDAR QUERY (via HTTP API)
        // ======================================================================

        /**
         * Accumulate response body with byte cap (avoids OOM on huge JSON.parse).
         * @returns {void}
         */
        function consumeCalendarResponse(res, title, done) {
            const chunks = [];
            let totalBytes = 0;
            let finished = false;
            function finish(err, data) {
                if (finished) return;
                finished = true;
                done(err, data);
            }
            res.on("data", (chunk) => {
                if (finished) return;
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
                totalBytes += buf.length;
                if (totalBytes > CALENDAR_MAX_RESPONSE_BYTES) {
                    try {
                        res.destroy();
                    } catch (e) {
                        /* ignore */
                    }
                    finish(new Error(`response larger than ${calendarMaxResponseMB}MB`), "");
                    return;
                }
                chunks.push(buf);
            });
            res.on("end", () => {
                if (finished) return;
                finish(null, Buffer.concat(chunks).toString("utf8"));
            });
            res.on("error", (e) => {
                finish(e, "");
            });
        }

        function queryCalendarSeries(title, defaultValue, callback) {
            const now = Math.floor(Date.now() / 1000);
            const endTime = now + totalSlots * slotDuration;
            const startTime = now - CALENDAR_LOOKBACK_SEC;

            const queryParams = new URLSearchParams({
                title: title,
                start: startTime.toString(),
                end: endTime.toString()
            });

            const url = `http://${calendarHost}:${calendarPort}/calendar?${queryParams.toString()}`;

            http.get(url, { timeout: 8000 }, (res) => {
                consumeCalendarResponse(res, title, (err, data) => {
                    if (err) {
                        node.warn(`Calendar query failed for ${title}: ${err.message}`);
                        return callback(new Array(totalSlots).fill(defaultValue));
                    }
                    try {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            node.warn(`Calendar query failed for ${title}: HTTP ${res.statusCode}`);
                            return callback(new Array(totalSlots).fill(defaultValue));
                        }

                        let rows;
                        try {
                            rows = JSON.parse(data);
                        } catch (e) {
                            node.warn(`Calendar query failed for ${title}: Invalid JSON (${e.message})`);
                            return callback(new Array(totalSlots).fill(defaultValue));
                        }

                        if (!Array.isArray(rows)) {
                            node.warn(`Calendar query failed for ${title}: Response not an array`);
                            return callback(new Array(totalSlots).fill(defaultValue));
                        }

                        const normalizedRows = rows
                            .filter((p) => p.timestamp !== undefined && p.value !== undefined)
                            .map((p) => ({
                                timestamp: p.timestamp > 1e12 ? Math.floor(p.timestamp / 1000) : Math.floor(p.timestamp),
                                value: parseFloat(p.value)
                            }))
                            .filter((p) => Number.isFinite(p.value))
                            .sort((a, b) => a.timestamp - b.timestamp);

                        const values = [];
                        const baseSlot = Math.floor(now / slotDuration) * slotDuration;
                        let seriesStep = slotDuration;
                        if (normalizedRows.length >= 2) {
                            const d = normalizedRows[1].timestamp - normalizedRows[0].timestamp;
                            if (d > 0) seriesStep = d;
                        }
                        const slotLongerThanStep = slotDuration > seriesStep;

                        for (let s = 0; s < totalSlots; s++) {
                            const slotStart = baseSlot + s * slotDuration;
                            const slotEnd = slotStart + slotDuration;
                            let value = null;

                            if (slotLongerThanStep && normalizedRows.length > 0) {
                                let sum = 0,
                                    weight = 0;
                                for (let i = 0; i < normalizedRows.length; i++) {
                                    const tEnd = i + 1 < normalizedRows.length ? normalizedRows[i + 1].timestamp : slotEnd;
                                    const w = Math.min(tEnd, slotEnd) - Math.max(normalizedRows[i].timestamp, slotStart);
                                    if (w > 0) {
                                        sum += normalizedRows[i].value * w;
                                        weight += w;
                                    }
                                }
                                value = weight > 0 ? sum / weight : null;
                            } else {
                                for (let i = normalizedRows.length - 1; i >= 0; i--) {
                                    if (normalizedRows[i].timestamp <= slotStart) {
                                        value = normalizedRows[i].value;
                                        break;
                                    }
                                }
                            }

                            values.push(value !== null && Number.isFinite(value) ? value : defaultValue);
                        }

                        callback(values);
                    } catch (e) {
                        node.warn(`Calendar query failed for ${title}: ${e.message}`);
                        callback(new Array(totalSlots).fill(defaultValue));
                    }
                });
            })
                .on("error", (err) => {
                    node.warn(`Calendar query failed for ${title}: ${err.message}`);
                    return callback(new Array(totalSlots).fill(defaultValue));
                })
                .on("timeout", () => {
                    node.warn(`Calendar query timeout for ${title}`);
                    return callback(new Array(totalSlots).fill(defaultValue));
                });
        }

        // Query calendar series at a fixed step (e.g. 15 min); returns value at slot start for each slot.
        function queryCalendarSeriesAtStep(title, defaultValue, stepSeconds, numSlots, callback, maxHoldSeconds) {
            const now = Math.floor(Date.now() / 1000);
            const endTime = now + numSlots * stepSeconds;
            const startTime = now - CALENDAR_LOOKBACK_SEC;
            const queryParams = new URLSearchParams({
                title: title,
                start: startTime.toString(),
                end: endTime.toString()
            });
            const url = `http://${calendarHost}:${calendarPort}/calendar?${queryParams.toString()}`;
            http.get(url, { timeout: 8000 }, (res) => {
                consumeCalendarResponse(res, title, (err, data) => {
                    if (err) {
                        node.warn(`Calendar query failed for ${title}: ${err.message}`);
                        return callback(new Array(numSlots).fill(defaultValue));
                    }
                    try {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            node.warn(`Calendar query failed for ${title}: HTTP ${res.statusCode}`);
                            return callback(new Array(numSlots).fill(defaultValue));
                        }
                        let rows;
                        try {
                            rows = JSON.parse(data);
                        } catch (e) {
                            node.warn(`Calendar query failed for ${title}: Invalid JSON (${e.message})`);
                            return callback(new Array(numSlots).fill(defaultValue));
                        }
                        if (!Array.isArray(rows)) {
                            node.warn(`Calendar query failed for ${title}: Response not an array`);
                            return callback(new Array(numSlots).fill(defaultValue));
                        }
                        const normalizedRows = rows
                            .filter((p) => p.timestamp !== undefined && p.value !== undefined)
                            .map((p) => ({
                                timestamp: p.timestamp > 1e12 ? Math.floor(p.timestamp / 1000) : Math.floor(p.timestamp),
                                value: parseFloat(p.value)
                            }))
                            .filter((p) => Number.isFinite(p.value))
                            .sort((a, b) => a.timestamp - b.timestamp);
                        const baseSlot = Math.floor(now / stepSeconds) * stepSeconds;
                        const values = [];
                        for (let s = 0; s < numSlots; s++) {
                            const slotStart = baseSlot + s * stepSeconds;
                            let value = null;
                            for (let i = normalizedRows.length - 1; i >= 0; i--) {
                                if (normalizedRows[i].timestamp <= slotStart) {
                                    if (maxHoldSeconds != null && slotStart - normalizedRows[i].timestamp >= maxHoldSeconds) {
                                        break;
                                    }
                                    value = normalizedRows[i].value;
                                    break;
                                }
                            }
                            values.push(value !== null && Number.isFinite(value) ? value : defaultValue);
                        }
                        callback(values);
                    } catch (e) {
                        node.warn(`Calendar query failed for ${title}: ${e.message}`);
                        callback(new Array(numSlots).fill(defaultValue));
                    }
                });
            })
                .on("error", (err) => {
                    node.warn(`Calendar query failed for ${title}: ${err.message}`);
                    return callback(new Array(numSlots).fill(defaultValue));
                })
                .on("timeout", () => {
                    node.warn(`Calendar query timeout for ${title}`);
                    return callback(new Array(numSlots).fill(defaultValue));
                });
        }

        // Date mean at slotStart+heatLeadH. Last known mean is kept past the forecast.
        // Falls back to hourly Tout when the average series is missing.
        function toutBalanceAt(slotStartSec, hourlyTout) {
            const cache = node.context().global.get("forecastCache");
            if (!cache || !Array.isArray(cache.ToutAvg) || cache.ToutAvg.length === 0) return hourlyTout;
            if (!Number.isFinite(cache.baseSlot) || !Number.isFinite(cache.stepSec) || cache.stepSec <= 0) return hourlyTout;
            const age = Date.now() - (cache.timestamp || 0);
            if (age > FORECAST_CACHE_MAX_AGE_MS) return hourlyTout;
            const arr = cache.ToutAvg;
            let idx = Math.floor((slotStartSec + heatLeadH * 3600 - cache.baseSlot) / cache.stepSec);
            if (idx < 0) idx = 0;
            if (idx >= arr.length) idx = arr.length - 1;
            for (let i = idx; i >= 0; i--) {
                if (Number.isFinite(arr[i])) return arr[i];
            }
            return hourlyTout;
        }

        /** Map MPC slot starts onto forecast-cache grid (piecewise-constant, same semantics as calendar query). */
        function sampleForecastGrid(arr, cacheBaseSlot, cacheStepSec, slotStartSec, defaultVal) {
            if (!Array.isArray(arr) || arr.length === 0) return defaultVal;
            let j = Math.floor((slotStartSec - cacheBaseSlot) / cacheStepSec);
            if (j < 0) j = 0;
            if (j >= arr.length) j = arr.length - 1;
            const v = arr[j];
            return Number.isFinite(v) ? v : defaultVal;
        }

        /**
         * Build Tout/wind arrays for MPC from flow.forecastCache when fresh (uniflex-forecast-cache node).
         * @returns {{ ToutArr: number[], windArr: number[], cacheTimestamp: number } | null}
         */
        function tryToutWindFromForecastCache(mpcBaseSlot, mpcSlotDur, numSlots, defaultTout, defaultWind) {
            if (!useForecastCache) return null;
            const cache = node.context().global.get("forecastCache");
            if (!cache || typeof cache !== "object") return null;
            if (!Number.isFinite(cache.baseSlot) || !Number.isFinite(cache.stepSec) || cache.stepSec <= 0) return null;
            const ts = cache.timestamp || 0;
            const age = Date.now() - ts;
            if (age > FORECAST_CACHE_MAX_AGE_MS) {
                debug(
                    `[mpc-house:${node.name}] forecastCache stale (${(age / 60000).toFixed(0)} min > ${FORECAST_CACHE_MAX_AGE_MS / 60000} min) -- will query calendar for Tout/wind`
                );
                return null;
            }
            const tout = cache.Tout;
            const wind = cache.wind;
            if (!Array.isArray(tout) || !Array.isArray(wind) || tout.length === 0 || wind.length === 0) {
                return null;
            }

            const ToutArr = [];
            const windArr = [];
            for (let k = 0; k < numSlots; k++) {
                const slotStart = mpcBaseSlot + k * mpcSlotDur;
                ToutArr.push(sampleForecastGrid(tout, cache.baseSlot, cache.stepSec, slotStart, defaultTout));
                windArr.push(sampleForecastGrid(wind, cache.baseSlot, cache.stepSec, slotStart, defaultWind));
            }
            return { ToutArr, windArr, cacheTimestamp: ts };
        }

        // On-event value is kWh as a numeric string ("1.5"). "0" and "" mean off.
        // Keep at least 0.1 so a short block does not collapse to 0 and read as off.
        function kwhOnValue(kwh) {
            const n = Number(kwh);
            const safe = Number.isFinite(n) && n >= 0.05 ? n : 0.1;
            return safe.toFixed(1);
        }

        function calendarJson(method, path, bodyObj) {
            return new Promise((resolve) => {
                const payload = bodyObj ? JSON.stringify(bodyObj) : null;
                const headers = {};
                if (payload) {
                    headers["Content-Type"] = "application/json";
                    headers["Content-Length"] = Buffer.byteLength(payload);
                }
                const req = http.request(
                    {
                        hostname: calendarHost,
                        port: calendarPort,
                        path: path,
                        method: method,
                        timeout: 8000,
                        headers: headers
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (chunk) => (data += chunk));
                        res.on("end", () => {
                            let parsed = null;
                            try {
                                parsed = data ? JSON.parse(data) : null;
                            } catch (e) {
                                parsed = null;
                            }
                            resolve({ status: res.statusCode || 0, body: parsed });
                        });
                    }
                );
                req.on("error", () => resolve({ status: 0, body: null }));
                req.on("timeout", () => {
                    req.destroy();
                    resolve({ status: 0, body: null });
                });
                if (payload) req.write(payload);
                req.end();
            });
        }

        async function putEventRow(title, mid, timestamp, value) {
            const r = await calendarJson("PUT", "/calendar", {
                configuration: { id: Number(mid), title: title, timestamp: timestamp, value: value }
            });
            const ok = r.status >= 200 && r.status < 300;
            if (!ok) node.warn(`[mpc-house:${node.name}] calendar PUT ${title} mid=${mid} ts=${timestamp} failed status=${r.status}`);
            return ok;
        }

        async function findOngoingEvents(title, nowSec) {
            const from = nowSec - 2 * 86400;
            const to = nowSec + 3600;
            const path = `/calendar?title=${encodeURIComponent(title)}&start=${from}&end=${to}&events=true`;
            const r = await calendarJson("GET", path);
            const list = [];
            const rows = Array.isArray(r.body) ? r.body : [];
            for (const evt of rows) {
                const ts1 = Number(evt.ts1 != null ? evt.ts1 : evt.start);
                const ts2 = Number(evt.ts2 != null ? evt.ts2 : evt.end);
                const mid = evt.mid != null ? evt.mid : evt.id;
                if (!Number.isFinite(ts1) || !Number.isFinite(ts2) || mid == null) continue;
                if (ts1 <= nowSec && nowSec < ts2) list.push({ mid: mid, start: ts1, end: ts2 });
            }
            const chk = await calendarJson("GET", `/calendar?title=${encodeURIComponent(title)}&check=true`);
            const cv = chk.body && chk.body.value;
            const cmid = chk.body && chk.body.mid;
            const on = cv != null && cv !== "" && Number(cv) !== 0;
            if (on && cmid != null && !list.some((e) => String(e.mid) === String(cmid))) {
                list.push({ mid: cmid, start: nowSec, end: nowSec + 1, orphan: true });
            }
            return list;
        }

        // If the new plan is ON in the current slot, keep the running event and move its end.
        // The delete that follows must not include that event: cal_store removes an event only
        // when both start and end sit inside the delete window. A start at currentSlot would
        // otherwise be deleted, and the continued block is not written again.
        // If the next ON block starts later, close the running event at now before that delete.
        async function settleOngoing(title, newEvents, currentSlot, nowSec) {
            const fmtTs = (t) => new Date(t * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
            let deleteFrom = currentSlot;
            let eventsToWrite = newEvents;
            if (!title) return { eventsToWrite: eventsToWrite, deleteFrom: deleteFrom };
            const ongoing = await findOngoingEvents(title, nowSec);
            if (ongoing.length === 0) return { eventsToWrite: eventsToWrite, deleteFrom: deleteFrom };
            const followNow = newEvents.length > 0 && newEvents[0].start === currentSlot;
            if (followNow) {
                const keep = ongoing.reduce((a, b) => (a.start >= b.start ? a : b));
                const newEnd = newEvents[0].end;
                const newVal = newEvents[0].value;
                await putEventRow(title, keep.mid, keep.start, newVal);
                await putEventRow(title, keep.mid, newEnd, "");
                log(`[mpc-house:${node.name}] ${title}: continue mid=${keep.mid} ${fmtTs(keep.start)}->${fmtTs(newEnd)} value=${newVal}`);
                for (const extra of ongoing) {
                    if (String(extra.mid) === String(keep.mid)) continue;
                    const stopAt = Math.max(nowSec, extra.start + 1);
                    await putEventRow(title, extra.mid, stopAt, "");
                    log(`[mpc-house:${node.name}] ${title}: closed extra ongoing mid=${extra.mid} at ${fmtTs(stopAt)}`);
                    if (extra.start >= currentSlot) deleteFrom = Math.max(deleteFrom, stopAt + 1);
                }
                eventsToWrite = newEvents.slice(1);
                if (keep.start >= currentSlot) deleteFrom = Math.max(deleteFrom, keep.start + 1);
            } else {
                for (const ev of ongoing) {
                    const stopAt = Math.max(nowSec, ev.start + 1);
                    await putEventRow(title, ev.mid, stopAt, "");
                    log(`[mpc-house:${node.name}] ${title}: stop mid=${ev.mid} at ${fmtTs(stopAt)} (next block does not follow immediately)`);
                    if (ev.start >= currentSlot) deleteFrom = Math.max(deleteFrom, stopAt + 1);
                }
            }
            return { eventsToWrite: eventsToWrite, deleteFrom: deleteFrom };
        }

        // Check if there's an ongoing event for a title and get its mid
        // Returns Promise<{value, mid}> or Promise<null> if no ongoing event
        function checkOngoingEvent(title) {
            return new Promise((resolve) => {
                const path = `/calendar?check=true&title=${encodeURIComponent(title)}`;
                const req = http.request(
                    {
                        hostname: calendarHost,
                        port: calendarPort,
                        path: path,
                        method: "GET",
                        timeout: 5000
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (chunk) => (data += chunk));
                        res.on("end", () => {
                            try {
                                const result = JSON.parse(data);
                                if (result.value && result.mid) {
                                    resolve({ value: result.value, mid: result.mid });
                                } else {
                                    resolve(null);
                                }
                            } catch (e) {
                                resolve(null);
                            }
                        });
                    }
                );
                req.on("error", () => resolve(null));
                req.on("timeout", () => {
                    req.destroy();
                    resolve(null);
                });
                req.end();
            });
        }

        // Truncate an ongoing event's end time via sql-calendar node (PUT)
        function truncateEvent(title, mid, newEndTime, send) {
            send({
                topic: calendarTopic,
                mode: "update",
                title: title,
                eventId: mid,
                timestamp: newEndTime,
                value: ""
            });
            debug(`[mpc-house:${node.name}] Truncate ${title} mid=${mid} to ${new Date(newEndTime * 1000).toISOString().substring(11, 16)}`);
        }

        // Write HP and Gas schedules to calendar
        // IMPORTANT: Only write FUTURE schedule (from current slot onwards)
        // Past schedule is preserved as historical record of what actually happened
        // HP/gas work sessions are written as EVENTS with start/end times (not individual slot points)
        // Q_hp is electrical kW for the HP block. Q_gas is heat output kW.
        async function writeSchedules(hp_ena, gas_ena, Q_hp, Q_gas, send, slotDurationParam, planHeat, planElec, skipCoastBlank) {
            const now = Math.floor(Date.now() / 1000);
            const writeSlotDuration = slotDurationParam != null ? slotDurationParam : slotDuration;
            const currentSlot = Math.floor(now / writeSlotDuration) * writeSlotDuration;
            const S = hp_ena.length;

            // Work on copies so the caller's arrays (and schedule context object) are not mutated
            hp_ena = hp_ena.slice();
            gas_ena = gas_ena.slice();
            Q_hp = Q_hp.slice();
            Q_gas = Q_gas.slice();
            if (planHeat) planHeat = planHeat.slice();
            if (planElec) planElec = planElec.slice();

            // Coast-window suppression: when valve gate is active (avg openness < threshold),
            // the house is thermally satisfied. Blank leading HP/gas slots until Ti is predicted
            // to decay back to setpoint (single-RC exponential approximation, Tf excluded).
            if (
                !skipCoastBlank &&
                Number.isFinite(avgValveOpenness) &&
                Number.isFinite(valveGateThreshold) &&
                avgValveOpenness < valveGateThreshold &&
                Number.isFinite(Ti) &&
                Number.isFinite(lastTout) &&
                Number.isFinite(lastTsetUsed)
            ) {
                const Uenv_eff = Uenv_base + k_temp * Math.max(0, Tbalance_model - lastTout);
                const Ti_ss = lastTout + Q_internal / Uenv_eff; // Ti steady-state with HP off
                let coastSlots = 0;
                if (Ti > lastTsetUsed && lastTsetUsed > Ti_ss + 0.1) {
                    const tau_h = Ci / Uenv_eff; // RC time constant in hours
                    const tCoastH = tau_h * Math.log((Ti - Ti_ss) / (lastTsetUsed - Ti_ss));
                    coastSlots = Math.max(0, Math.ceil((tCoastH * 3600) / writeSlotDuration));
                }
                coastSlots = Math.min(coastSlots, S);
                if (coastSlots > 0) {
                    for (let s = 0; s < coastSlots; s++) {
                        hp_ena[s] = 0;
                        gas_ena[s] = 0;
                        Q_hp[s] = 0;
                        Q_gas[s] = 0;
                        if (planHeat) planHeat[s] = 0;
                        if (planElec) planElec[s] = 0;
                    }
                    log(
                        `[mpc-house:${node.name}] Valve gate: avg=${avgValveOpenness.toFixed(1)}% < ${valveGateThreshold.toFixed(1)}% -- blanked first ${coastSlots} slots (Ti=${Ti.toFixed(1)}, Tset=${lastTsetUsed.toFixed(1)}, Ti_ss=${Ti_ss.toFixed(1)} degC, tau=${(Ci / Uenv_eff).toFixed(1)}h)`
                    );
                }
            }

            const slotHours = writeSlotDuration / 3600;
            function consolidateToEvents(ena_array, Q_array, startTime) {
                const events = [];
                let eventStart = null;
                let eventStartIdx = null;

                for (let s = 0; s <= ena_array.length; s++) {
                    const isOn = s < ena_array.length && ena_array[s] === 1;
                    const ts = startTime + s * writeSlotDuration;

                    if (isOn && eventStart === null) {
                        eventStart = ts;
                        eventStartIdx = s;
                    } else if (!isOn && eventStart !== null) {
                        let energyKwh = 0;
                        for (let i = eventStartIdx; i < s; i++) {
                            energyKwh += (Q_array[i] || 0) * slotHours;
                        }
                        const durationHours = (s - eventStartIdx) * slotHours;
                        const avgPowerKw = durationHours > 0 ? energyKwh / durationHours : 0;
                        // Numeric kWh. Non-zero is ON; the end row (empty value) is OFF.
                        const displayValue = kwhOnValue(energyKwh);
                        debug(
                            `[mpc-house:${node.name}] block ${new Date(eventStart * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" })}->${new Date(ts * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" })} ${displayValue} kWh avg ${avgPowerKw.toFixed(1)} kW`
                        );
                        events.push({ start: eventStart, end: ts, value: displayValue });
                        eventStart = null;
                        eventStartIdx = null;
                    }
                }
                return events;
            }

            const hpEvents = consolidateToEvents(hp_ena, Q_hp, currentSlot);
            const gasEvents = consolidateToEvents(gas_ena, Q_gas, currentSlot);

            // Schedule change detection: compare new events with last written signature.
            // Signature = slot-relative start/end indices so it's independent of absolute time.
            // A null stored signature (first run or after restart) always counts as "changed".
            const newSig = JSON.stringify({
                hp: hpEvents.map((e) => ({ s: Math.round((e.start - currentSlot) / writeSlotDuration), e: Math.round((e.end - currentSlot) / writeSlotDuration) })),
                gas: gasEvents.map((e) => ({ s: Math.round((e.start - currentSlot) / writeSlotDuration), e: Math.round((e.end - currentSlot) / writeSlotDuration) }))
            });
            const prevSig = node.context().get("lastScheduleSig") || null;
            const scheduleChanged = newSig !== prevSig;

            if (scheduleChanged) {
                const hpHoursNew = hpEvents.reduce((sum, e) => sum + (e.end - e.start) / 3600, 0).toFixed(1);
                const gasHoursNew = gasEvents.reduce((sum, e) => sum + (e.end - e.start) / 3600, 0).toFixed(1);
                if (prevSig) {
                    const prev = JSON.parse(prevSig);
                    const hpHoursPrev = prev.hp.reduce((sum, e) => sum + ((e.e - e.s) * writeSlotDuration) / 3600, 0).toFixed(1);
                    const gasHoursPrev = prev.gas.reduce((sum, e) => sum + ((e.e - e.s) * writeSlotDuration) / 3600, 0).toFixed(1);
                    log(`[mpc-house:${node.name}] Schedule CHANGED: HP ${hpHoursPrev}h->${hpHoursNew}h, gas ${gasHoursPrev}h->${gasHoursNew}h -- rewriting calendar`);
                } else {
                    log(`[mpc-house:${node.name}] Schedule CHANGED (first run / post-restart): HP=${hpHoursNew}h gas=${gasHoursNew}h -- rewriting calendar`);
                }
            } else {
                log(`[mpc-house:${node.name}] Schedule UNCHANGED -- skipping calendar rewrite, no chart refresh needed`);
                return;
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const yesterday00 = Math.floor(today.getTime() / 1000) - 86400;
            const farFuture = currentSlot + 7 * 86400;

            // Step 1: Cleanup OLD data (before yesterday 00:00)
            if (hpScheduleTitle) {
                send({ topic: calendarTopic, mode: "delete", title: hpScheduleTitle, start: 0, end: yesterday00 });
            }
            if (gasScheduleTitle) {
                send({ topic: calendarTopic, mode: "delete", title: gasScheduleTitle, start: 0, end: yesterday00 });
            }
            // plan_heat, plan_elec, actual_heat and actual_elec older than yesterday
            // are removed once a day by power2calendar in the flow.

            const fmtTs = (ts) => new Date(ts * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });

            // Step 2: Continue a run only when the new plan is ON in this same slot.
            // Close it first when the next ON block starts later. Both updates finish
            // before the delete, and the kept event is left outside the delete window.
            const hpSettled = await settleOngoing(hpScheduleTitle, hpEvents, currentSlot, now);
            const gasSettled = await settleOngoing(gasScheduleTitle, gasEvents, currentSlot, now);
            const hpEventsToWrite = hpSettled.eventsToWrite;
            const gasEventsToWrite = gasSettled.eventsToWrite;

            // Delete future events. deleteFrom is currentSlot, or just after a kept event's start.
            if (hpScheduleTitle) send({ topic: calendarTopic, mode: "delete", title: hpScheduleTitle, start: hpSettled.deleteFrom, end: farFuture });
            if (gasScheduleTitle) send({ topic: calendarTopic, mode: "delete", title: gasScheduleTitle, start: gasSettled.deleteFrom, end: farFuture });
            if (planHeatTitle) send({ topic: calendarTopic, mode: "delete", title: planHeatTitle, start: currentSlot, end: farFuture });
            if (planElecTitle) send({ topic: calendarTopic, mode: "delete", title: planElecTitle, start: currentSlot, end: farFuture });

            // Step 3: Write fresh events after a short delay to let deletes process
            setTimeout(async () => {
                debug(`[mpc-house:${node.name}] HP events to write: ${hpEventsToWrite.map((e) => `${fmtTs(e.start)}->${fmtTs(e.end)} val="${e.value}"`).join(", ") || "(none)"}`);
                debug(`[mpc-house:${node.name}] Gas events to write: ${gasEventsToWrite.map((e) => `${fmtTs(e.start)}->${fmtTs(e.end)} val="${e.value}"`).join(", ") || "(none)"}`);

                if (hpEvents.length === 0 && hp_ena.filter((v) => v === 1).length > 0) {
                    node.error(
                        `[mpc-house:${node.name}] BUG: hp_ena has ${hp_ena.filter((v) => v === 1).length} enabled slots but consolidateToEvents returned 0 events! startTime=${currentSlot}`
                    );
                }

                for (const evt of hpEventsToWrite) {
                    send({ topic: calendarTopic, mode: "create", title: hpScheduleTitle, value: evt.value, start: evt.start, end: evt.end });
                }
                for (const evt of gasEventsToWrite) {
                    send({ topic: calendarTopic, mode: "create", title: gasScheduleTitle, value: evt.value, start: evt.start, end: evt.end });
                }

                // Per-slot plan_heat and plan_elec (kW) for power chart
                if (planHeatTitle && planHeat && planHeat.length > 0) {
                    for (let s = 0; s < planHeat.length; s++) {
                        send({
                            topic: calendarTopic,
                            mode: "create",
                            title: planHeatTitle,
                            value: parseFloat(planHeat[s].toFixed(2)),
                            timestamp: currentSlot + s * writeSlotDuration
                        });
                    }
                }
                if (planElecTitle && planElec && planElec.length > 0) {
                    for (let s = 0; s < planElec.length; s++) {
                        send({
                            topic: calendarTopic,
                            mode: "create",
                            title: planElecTitle,
                            value: parseFloat(planElec[s].toFixed(2)),
                            timestamp: currentSlot + s * writeSlotDuration
                        });
                    }
                }

                const hpHours = ((hp_ena.filter((v) => v === 1).length * writeSlotDuration) / 3600).toFixed(1);
                const gasHours = ((gas_ena.filter((v) => v === 1).length * writeSlotDuration) / 3600).toFixed(1);
                const overlapHours = ((hp_ena.filter((v, i) => v === 1 && gas_ena[i] === 1).length * writeSlotDuration) / 3600).toFixed(1);
                const hpReused = hpEvents.length > hpEventsToWrite.length ? 1 : 0;
                const gasReused = gasEvents.length > gasEventsToWrite.length ? 1 : 0;
                log(
                    `[mpc-house:${node.name}] Wrote FUTURE schedules (from ${fmtTs(currentSlot)}): HP=${hpEventsToWrite.length} new +${hpReused} reused (${hpHours}h) gas=${gasEventsToWrite.length} new +${gasReused} reused (${gasHours}h) overlap=${overlapHours}h`
                );

                // Verify: query calendar for hp_ena events in the planned window.
                // Range query (not checkOngoingEvent) so it works even when HP starts hours from now.
                setTimeout(async () => {
                    let writeOk = true;
                    if (hpScheduleTitle && hpEvents.length > 0) {
                        try {
                            const firstStart = hpEvents[0].start;
                            const vPath = `/calendar?title=${encodeURIComponent(hpScheduleTitle)}&start=${firstStart}&end=${farFuture}&events=true`;
                            const vResp = await new Promise((resolve, reject) => {
                                const req = http.request({ hostname: calendarHost, port: calendarPort, path: vPath, method: "GET", timeout: 5000 }, (res) => {
                                    let d = "";
                                    res.on("data", (c) => (d += c));
                                    res.on("end", () => {
                                        try {
                                            resolve(JSON.parse(d));
                                        } catch (e) {
                                            reject(e);
                                        }
                                    });
                                });
                                req.on("error", reject);
                                req.on("timeout", () => {
                                    req.destroy();
                                    reject(new Error("timeout"));
                                });
                                req.end();
                            });
                            writeOk = Array.isArray(vResp) && vResp.length > 0;
                        } catch (e) {
                            node.warn(`[mpc-house:${node.name}] Schedule verify request failed: ${e.message} -- assuming OK`);
                            writeOk = true;
                        }
                    }

                    if (hpEvents.length > 0 && !writeOk) {
                        node.error(`[mpc-house:${node.name}] CRITICAL: Schedule write FAILED -- no hp_ena events found in calendar. Check disk space or database integrity.`);
                        node.status({ fill: "red", shape: "ring", text: "Schedule write FAILED" });
                        // No automatic retry -- a blind retry risks duplicates if write partially succeeded
                    } else {
                        if (hpEvents.length > 0) debug(`[mpc-house:${node.name}] Schedule verified OK`);
                        node.status({ fill: "green", shape: "dot", text: hpEvents.length > 0 ? "Schedule OK" : "No HP scheduled" });
                        node.context().set("lastScheduleSig", newSig);
                        saveState();
                        if (scheduleChangedOutTopic) {
                            const hpH = hpEvents.reduce((sum, e) => sum + (e.end - e.start) / 3600, 0).toFixed(1);
                            const gasH = gasEvents.reduce((sum, e) => sum + (e.end - e.start) / 3600, 0).toFixed(1);
                            send({ topic: scheduleChangedOutTopic, payload: hpEvents.length > 0 ? 1 : 0, hp_hours: parseFloat(hpH), gas_hours: parseFloat(gasH) });
                            log(`[mpc-house:${node.name}] Published schedule-changed notification -> ${scheduleChangedOutTopic}`);
                        }
                    }
                }, 2000);
            }, 500);
        }

        // ======================================================================
        // MPC OPTIMIZATION
        // ======================================================================

        // Parse numeric payload: number, array (first finite element), or object .1 / .2 / value
        function parseNumericPayload(payload) {
            if (payload == null) return NaN;
            const n = Number(payload);
            if (Number.isFinite(n)) return n;
            if (Array.isArray(payload)) {
                for (let i = 0; i < payload.length; i++) {
                    const v = Number(payload[i]);
                    if (Number.isFinite(v)) return v;
                }
            }
            if (typeof payload === "object") {
                const v = payload[".1"] ?? payload[".2"] ?? payload.value;
                if (v != null && Number.isFinite(Number(v))) return Number(v);
            }
            return NaN;
        }

        function updateTiTrend(nextTi) {
            if (!Number.isFinite(nextTi)) return;
            const nowMs = Date.now();
            if (Number.isFinite(tiTrendLastVal) && Number.isFinite(tiTrendLastTs)) {
                const dtSec = (nowMs - tiTrendLastTs) / 1000;
                if (dtSec >= TI_TREND_MIN_DT_SEC && dtSec <= TI_TREND_MAX_DT_SEC) {
                    const instSlopeCph = (nextTi - tiTrendLastVal) / (dtSec / 3600);
                    if (Number.isFinite(instSlopeCph)) {
                        tiTrendSlopeCph = (1 - TI_TREND_EMA_ALPHA) * tiTrendSlopeCph + TI_TREND_EMA_ALPHA * instSlopeCph;
                    }
                }
            }
            tiTrendLastVal = nextTi;
            tiTrendLastTs = nowMs;
        }

        function runMPC(send, fullRecalc = true) {
            if (!Number.isFinite(Ti)) {
                node.warn(`Ti not available (topic: ${tiTopic || "(not set)"}), skipping MPC. Ensure indoor temp is wired and payload is a number or datastream array.`);
                return;
            }

            // === Model validation: compare prediction vs actual ===
            if (enableAdaptiveFeedback && Ti_pred_last !== null && timestamp_last !== null) {
                const hoursSinceLast = (Date.now() - timestamp_last) / 3600000;

                // Validate if last prediction was ~1 hour ago (allow 0.5-2h window)
                if (hoursSinceLast >= 0.5 && hoursSinceLast <= 2.0) {
                    const model_error = Ti - Ti_pred_last; // actual - predicted
                    modelErrorHistory.push({ error: model_error, timestamp: Date.now() });
                    if (modelErrorHistory.length > MAX_ERROR_HISTORY) {
                        modelErrorHistory.shift(); // Keep only recent history
                    }

                    // Log model validation results
                    if (Math.abs(model_error) > modelErrorThreshold) {
                        node.warn(
                            `[mpc-house:${node.name}] Model error HIGH: ${model_error >= 0 ? "+" : ""}${model_error.toFixed(2)}degC (Ti_actual=${Ti.toFixed(1)}degC vs Ti_pred=${Ti_pred_last.toFixed(1)}degC)`
                        );
                    } else {
                        log(
                            `[mpc-house:${node.name}] Model validation: error=${model_error >= 0 ? "+" : ""}${model_error.toFixed(2)}degC (within ${modelErrorThreshold}degC threshold)`
                        );
                    }

                    // === Adaptive comfort band adjustment ===
                    // If consistently too cold (negative error), tighten lower band
                    // If consistently too warm (positive error), tighten upper band
                    const recentErrors = modelErrorHistory.slice(-6); // Last 6 hours
                    if (recentErrors.length >= 4) {
                        const avgError = recentErrors.reduce((sum, e) => sum + e.error, 0) / recentErrors.length;

                        if (avgError < -modelErrorThreshold && bandLowAdjustment > -maxBandAdjustment) {
                            // Too cold: reduce lower band allowance
                            bandLowAdjustment -= adaptiveBandRate;
                            if (bandLowAdjustment < -maxBandAdjustment) bandLowAdjustment = -maxBandAdjustment;
                            log(
                                `[mpc-house:${node.name}] Adaptive: tightening band_low by ${adaptiveBandRate.toFixed(2)}degC -> total adj=${bandLowAdjustment.toFixed(2)}degC (avg 6h error=${avgError.toFixed(2)}degC, too cold)`
                            );
                            saveState();
                        } else if (avgError > modelErrorThreshold && bandHighAdjustment > -maxBandAdjustment) {
                            // Too warm: reduce upper band allowance
                            bandHighAdjustment -= adaptiveBandRate;
                            if (bandHighAdjustment < -maxBandAdjustment) bandHighAdjustment = -maxBandAdjustment;
                            log(
                                `[mpc-house:${node.name}] Adaptive: tightening band_high by ${adaptiveBandRate.toFixed(2)}degC -> total adj=${bandHighAdjustment.toFixed(2)}degC (avg 6h error=${avgError.toFixed(2)}degC, too warm)`
                            );
                            saveState();
                        }
                    }
                }
            }

            // Estimate Tf if not provided
            let TfUsed = Tf;
            if (!Number.isFinite(TfUsed)) {
                TfUsed = Ti + 2.5;
                if (!tfTopic) {
                    debug(`[mpc-house:${node.name}] Tf topic not configured, estimated Tf=${TfUsed.toFixed(1)}degC from Ti`);
                } else if (!warnedTfInvalid) {
                    node.warn(`[mpc-house:${node.name}] Tf missing/invalid on topic "${tfTopic}", estimated Tf=${TfUsed.toFixed(1)}degC from Ti (further warnings suppressed)`);
                    warnedTfInvalid = true;
                } else {
                    debug(`[mpc-house:${node.name}] Tf missing/invalid, estimated Tf=${TfUsed.toFixed(1)}degC from Ti`);
                }
            }
            // The AVGW.4 sensor tracks pipe temperature which overshoots in both
            // directions vs the bulk slab.  Real data shows floor_act converges to
            // within ~0.5degC of room_act during extended off periods.  The model's Tf
            // (80 kWh/degC) represents the bulk slab, not the pipes, so clamp the
            // init value to at most 0.5degC below room temp.
            const TfRaw = TfUsed;
            TfUsed = Math.max(TfUsed, Ti - 0.5);
            debug(`[mpc-house:${node.name}] Tf_sensor=${TfRaw.toFixed(1)}degC Tf_sim=${TfUsed.toFixed(1)}degC Ti=${Ti.toFixed(1)}degC (clamped=${TfRaw < Ti - 0.5})`);

            // Query all data from calendar (both price sources)
            log(`[mpc-house:${node.name}] Querying calendar data...`);
            const useBaseStep = priceStepMinutes > 0;
            const baseSlotDuration = useBaseStep ? priceStepMinutes * 60 : slotDuration;
            const baseTotalSlots = useBaseStep ? Math.floor((horizonHours * 3600) / baseSlotDuration) : totalSlots;

            function runOptimization(priceElecArr, priceGasArr, ToutArr, windArr) {
                log(
                    `[mpc-house:${node.name}] All calendar data loaded, running optimization (${useBaseStep ? "base step " + priceStepMinutes + " min" : "control interval " + controlIntervalMinutes + " min"})...`
                );
                try {
                    optimizeSchedule(
                        TfUsed,
                        priceElecArr,
                        priceGasArr,
                        ToutArr,
                        windArr,
                        send,
                        fullRecalc,
                        useBaseStep ? baseSlotDuration : null,
                        useBaseStep ? baseTotalSlots : null
                    );
                } catch (e) {
                    node.error(`[mpc-house:${node.name}] optimizeSchedule crashed: ${e.message}`);
                    if (e.stack) debug(e.stack);
                }
            }

            function fetchToutWindThenOptimize(priceElecArr, priceGasArr, mpcBaseSlot, mpcSlotDur, numSlots) {
                const fc = tryToutWindFromForecastCache(mpcBaseSlot, mpcSlotDur, numSlots, 0, 3.0);
                if (fc) {
                    const ageMin = ((Date.now() - fc.cacheTimestamp) / 60000).toFixed(0);
                    log(`[mpc-house:${node.name}] Using flow.forecastCache for Tout/wind (${fc.ToutArr.length} slots @ ${mpcSlotDur / 60} min, cache age ~${ageMin} min)`);
                    runOptimization(priceElecArr, priceGasArr, fc.ToutArr, fc.windArr);
                    return;
                }
                if (useBaseStep) {
                    queryCalendarSeriesAtStep(tempTitle, 0, mpcSlotDur, numSlots, function (ToutArr) {
                        queryCalendarSeriesAtStep(windTitle, 3.0, mpcSlotDur, numSlots, function (windArr) {
                            runOptimization(priceElecArr, priceGasArr, ToutArr, windArr);
                        });
                    });
                } else {
                    queryCalendarSeries(tempTitle, 0, function (ToutArr) {
                        log(`[mpc-house:${node.name}] Got ${ToutArr.length} temp forecasts`);
                        queryCalendarSeries(windTitle, 3.0, function (windArr) {
                            runOptimization(priceElecArr, priceGasArr, ToutArr, windArr);
                        });
                    });
                }
            }

            const nowSec = Math.floor(Date.now() / 1000);
            if (useBaseStep) {
                const mpcBaseSlot = Math.floor(nowSec / baseSlotDuration) * baseSlotDuration;
                queryCalendarSeriesAtStep(
                    priceTitleElec,
                    NaN,
                    baseSlotDuration,
                    baseTotalSlots,
                    function (priceElecArr) {
                        log(
                            `[mpc-house:${node.name}] Elec prices: ${priceElecArr.filter(Number.isFinite).length}/${priceElecArr.length} known slots @ ${priceStepMinutes} min ` +
                                "(trailing empty slots normal until next calendar fetch; not a fault)"
                        );
                        queryCalendarSeriesAtStep(priceTitleGas, NaN, baseSlotDuration, baseTotalSlots, function (priceGasArr) {
                            log(`[mpc-house:${node.name}] Got ${priceGasArr.length} gas prices @ ${priceStepMinutes} min`);
                            fetchToutWindThenOptimize(priceElecArr, priceGasArr, mpcBaseSlot, baseSlotDuration, baseTotalSlots);
                        });
                    },
                    baseSlotDuration
                );
            } else {
                const mpcBaseSlotHourly = Math.floor(nowSec / slotDuration) * slotDuration;
                queryCalendarSeries(priceTitleElec, NaN, function (priceElecArr) {
                    log(`[mpc-house:${node.name}] Got ${priceElecArr.length} elec prices`);
                    queryCalendarSeries(priceTitleGas, 0, function (priceGasArr) {
                        log(`[mpc-house:${node.name}] Got ${priceGasArr.length} gas prices`);
                        fetchToutWindThenOptimize(priceElecArr, priceGasArr, mpcBaseSlotHourly, slotDuration, totalSlots);
                    });
                });
            }
        }

        // Integrate floor+air heat while an HP block is on. Near the end of the block,
        // if the floors took at least 1 kWh less than planned, keep the HP on for the
        // missing energy at the same power. Stops at 2 h extra, or where electricity
        // heat is no longer cheaper than gas. Does not move the HP setpoint pair.
        const SHORTFALL_MIN_KWH = 1;
        const MAX_EXTRA_SLOTS = 8;

        function noteActualHeat(nowSec) {
            const schedule = node.context().get("schedule");
            if (!schedule || !Array.isArray(schedule.hp_ena) || !schedule.slotDurationUsed || schedule.baseSlot == null) return null;
            const step = schedule.slotDurationUsed;
            const base = schedule.baseSlot;
            const hp = schedule.hp_ena;
            const idx = Math.floor((nowSec - base) / step);
            let probe = idx;
            if ((probe < 0 || probe >= hp.length || hp[probe] !== 1) && probe - 1 >= 0 && hp[probe - 1] === 1) probe = probe - 1;
            let block = null;
            if (probe >= 0 && probe < hp.length && hp[probe] === 1) {
                let a = probe;
                while (a > 0 && hp[a - 1] === 1) a--;
                let b = probe + 1;
                while (b < hp.length && hp[b] === 1) b++;
                block = { a: a, b: b, startTs: base + a * step, endTs: base + b * step };
            }
            if (block && block.startTs === closedBlockStartTs) block = null;
            if (block && (!heatAccount || heatAccount.startTs !== block.startTs)) {
                const slotH = step / 3600;
                let planned = 0;
                let qSum = 0;
                let qN = 0;
                for (let i = block.a; i < block.b; i++) {
                    const q = schedule.Q && schedule.Q[i] ? schedule.Q[i] : 0;
                    planned += q * slotH;
                    if (q > 0.3) {
                        qSum += q;
                        qN++;
                    }
                }
                heatAccount = {
                    startTs: block.startTs,
                    origEndTs: block.endTs,
                    endTs: block.endTs,
                    plannedKwh: planned,
                    actualKwh: 0,
                    lastTs: nowSec,
                    qOn: qN > 0 ? qSum / qN : 8,
                    sawPower: false,
                    watchedFrom: nowSec
                };
            }
            if (heatAccount && nowSec >= heatAccount.startTs && nowSec < heatAccount.endTs) {
                if (heatAccount.lastTs && Q_floor_actual != null && Number.isFinite(Q_floor_actual)) {
                    const dt = nowSec - heatAccount.lastTs;
                    if (dt > 0 && dt <= 900) {
                        const qAir = Q_air_actual != null && Number.isFinite(Q_air_actual) ? Q_air_actual : 0;
                        heatAccount.actualKwh += (Q_floor_actual + qAir) * (dt / 3600);
                        heatAccount.sawPower = true;
                    }
                }
                heatAccount.lastTs = nowSec;
            }
            return schedule;
        }

        // Rooms open valves from chargeSignal, not from hp_ena. Copy the running
        // block's feedforward onto the extra slots so the floor setpoint stays up.
        function keepChargeFf(base, step, iFrom, iTo) {
            const sig = node.context().global.get("chargeSignal");
            if (!sig || !Array.isArray(sig.adj) || sig.baseSlot !== base || sig.stepSec !== step) {
                log(`[mpc-house:${node.name}] Charge FF not kept on extension (signal does not match this plan)`);
                return null;
            }
            const iStart = Math.round((heatAccount.startTs - base) / step);
            const iOrigEnd = Math.round((heatAccount.origEndTs - base) / step);
            let sum = 0;
            let n = 0;
            for (let i = iStart; i < iOrigEnd && i < sig.adj.length; i++) {
                if (Number.isFinite(sig.adj[i])) {
                    sum += sig.adj[i];
                    n++;
                }
            }
            if (n <= 0) return null;
            const keep = sum / n;
            if (!(keep > 0.05)) return null;
            for (let i = iFrom; i < iTo && i < sig.adj.length; i++) {
                const cur = Number.isFinite(sig.adj[i]) ? sig.adj[i] : 0;
                sig.adj[i] = Math.max(cur, keep);
            }
            sig.timestamp = Date.now();
            node.context().global.set("chargeSignal", sig);
            saveState();
            return keep;
        }

        function extendShortRun(send) {
            const nowSec = Math.floor(Date.now() / 1000);
            const schedule = noteActualHeat(nowSec);
            if (!schedule || !heatAccount || !heatAccount.sawPower || heatAccount.plannedKwh < SHORTFALL_MIN_KWH) return;
            const step = schedule.slotDurationUsed;
            const dur = Math.max(0, heatAccount.origEndTs - heatAccount.startTs);
            const needWatch = Math.min(600, Math.max(300, dur * 0.5));
            if (nowSec - heatAccount.watchedFrom < needWatch) return;
            if (nowSec < heatAccount.endTs - 30) return;
            const shortfall = heatAccount.plannedKwh - heatAccount.actualKwh;
            if (shortfall < SHORTFALL_MIN_KWH) {
                if (nowSec >= heatAccount.endTs) {
                    closedBlockStartTs = heatAccount.startTs;
                    heatAccount = null;
                }
                return;
            }
            const slotH = step / 3600;
            const qOn = heatAccount.qOn > 0.5 ? heatAccount.qOn : 8;
            const usedExtra = Math.round((heatAccount.endTs - heatAccount.origEndTs) / step);
            let need = Math.ceil(shortfall / (qOn * slotH));
            need = Math.min(need, MAX_EXTRA_SLOTS - usedExtra);
            if (need <= 0) {
                log(
                    `[mpc-house:${node.name}] Shortfall ${shortfall.toFixed(1)} kWh remains, extension cap ${MAX_EXTRA_SLOTS} slots reached`
                );
                closedBlockStartTs = heatAccount.startTs;
                heatAccount = null;
                return;
            }
            const base = schedule.baseSlot;
            const hp = schedule.hp_ena;
            const pe = schedule.priceElecBase;
            const pg = schedule.priceGasBase;
            let i0 = Math.round((heatAccount.endTs - base) / step);
            const idxNow = Math.floor((nowSec - base) / step);
            if (i0 < idxNow) i0 = idxNow;
            let added = 0;
            for (let i = i0; i < hp.length && added < need; i++) {
                if (hp[i] === 1) break;
                if (pe && pg && Number.isFinite(pe[i]) && Number.isFinite(pg[i]) && pg[i] > 0 && pe[i] >= pg[i]) break;
                hp[i] = 1;
                if (schedule.Q) schedule.Q[i] = qOn;
                if (schedule.allow) schedule.allow[i] = 1;
                added++;
                heatAccount.endTs = base + (i + 1) * step;
            }
            if (added <= 0) return;
            const ffKept = keepChargeFf(base, step, i0, i0 + added);
            log(
                `[mpc-house:${node.name}] Shortfall ${shortfall.toFixed(1)} kWh (planned ${heatAccount.plannedKwh.toFixed(1)}, got ${heatAccount.actualKwh.toFixed(1)}) -- extending ${added} slots at ${qOn.toFixed(1)} kW` +
                    (ffKept != null ? `, ff kept ${ffKept >= 0 ? "+" : ""}${ffKept.toFixed(2)} C` : "")
            );
            node.context().global.set("hpChargePlan", {
                baseSlot: base,
                stepSec: step,
                hp_ena: hp.slice(),
                timestamp: Date.now()
            });
            const from = Math.max(0, idxNow);
            const hpFrom = hp.slice(from);
            const gas = Array.isArray(schedule.gas_ena) ? schedule.gas_ena : [];
            const gasFrom = gas.slice(from);
            const qFrom = (schedule.Q || []).slice(from);
            const tout = Number.isFinite(lastTout) ? lastTout : 10;
            const qElec = qFrom.map((q, i) => {
                if (hpFrom[i] !== 1 || !(q > 0)) return 0;
                const cop = getCopAtTemp(tout, q);
                return cop > 0 ? q / cop : 0;
            });
            const qGas = gasFrom.map((on, i) => (on ? qFrom[i] || 0 : 0));
            writeSchedules(hpFrom, gasFrom, qElec, qGas, send, step, qFrom, qElec, true).catch((e) => {
                node.error(`[mpc-house:${node.name}] Error extending schedule: ${e.message}`);
            });
        }

        function optimizeSchedule(TfUsed, priceElecArr, priceGasArr, ToutArr, windArr, send, fullRecalc = true, slotDurationOverride = null, totalSlotsOverride = null) {
            if (fullRecalc) {
                heatAccount = null;
                closedBlockStartTs = 0;
            }
            const slotDurationUsed = slotDurationOverride != null ? slotDurationOverride : slotDuration;
            const totalSlotsUsed = totalSlotsOverride != null ? totalSlotsOverride : totalSlots;
            // Scheduling horizon = end of known electricity prices (not the configured horizon)
            let knownElecSlots = 0;
            for (let i = 0; i < priceElecArr.length; i++) {
                if (Number.isFinite(priceElecArr[i])) knownElecSlots = i + 1;
            }
            const S = Math.min(knownElecSlots, totalSlotsUsed, ToutArr.length, priceGasArr.length);
            if (S <= 0) {
                node.warn("No known electricity prices, nothing to schedule");
                return;
            }
            const slotHours = slotDurationUsed / 3600;
            const baseSlot = Math.floor(Date.now() / 1000 / slotDurationUsed) * slotDurationUsed;
            const slotsPerHourUsed = Math.round(3600 / slotDurationUsed);

            const priceArr = [];
            const hpPreferred = new Array(S).fill(false);
            const safeElecPrice = (i) => (Number.isFinite(priceElecArr[i]) ? priceElecArr[i] : Infinity);

            // Gas price forward-fill: gas prices change at most once/day so any missing slot
            // gets the nearest preceding known value. Hard fallback = 100 EUR/MWh (10000 in
            // internal units of 1e-5 EUR/kWh) if the calendar returned no gas prices at all.
            const GAS_PRICE_HARD_FALLBACK = 10000; // 100 EUR/MWh
            {
                const firstKnown = priceGasArr.find((v) => Number.isFinite(v) && v > 0);
                if (firstKnown == null) {
                    node.warn(`[mpc-house:${node.name}] Gas prices entirely missing -- using 100 EUR/MWh fallback`);
                }
                let ref = firstKnown != null ? firstKnown : GAS_PRICE_HARD_FALLBACK;
                for (let i = 0; i < priceGasArr.length; i++) {
                    if (Number.isFinite(priceGasArr[i]) && priceGasArr[i] > 0) ref = priceGasArr[i];
                    else priceGasArr[i] = ref;
                }
            }
            const safeGasPrice = (i) => (Number.isFinite(priceGasArr[i]) ? priceGasArr[i] : GAS_PRICE_HARD_FALLBACK);
            for (let s = 0; s < S; s++) {
                const pe = safeElecPrice(s);
                const pg = safeGasPrice(s);
                priceArr.push(Math.min(pe, pg));
            }

            // Use average setpoint from topic if available, otherwise config value
            const TsetUsed = TsetFromTopic !== null && Number.isFinite(TsetFromTopic) ? TsetFromTopic : Tset;

            // Apply adaptive band adjustments
            const bandLowEffective = Math.max(0.1, bandLow + bandLowAdjustment);
            const bandHighEffective = Math.max(0.1, bandHigh + bandHighAdjustment);
            const Tmin = TsetUsed - bandLowEffective;
            const Tmax = TsetUsed + bandHighEffective;

            // ================================================================
            // GLOBAL SCHEDULING ALGORITHM
            // ================================================================
            // Strategy: Maximize non-overlapping HP and Gas schedules to
            // deliver more total energy within distribution limits.
            // - HP for cheapest electricity hours
            // - Gas for remaining hours when HP is off (non-overlapping)
            // - Overlap only when continuous heating required (high demand)
            // ================================================================

            // Calculate HP capacity at each slot (derated by COP)
            const hp_capacity = ToutArr.map((T) => getHpCapacityAtTemp(T));
            const avg_hp_capacity = hp_capacity.slice(0, S).reduce((a, b) => a + b, 0) / S;
            const min_hp_capacity = Math.min(...hp_capacity);
            const slots_with_low_capacity = hp_capacity.filter((c) => c <= 0.5).length;

            // Build HP-vs-gas preference with deadband + lookahead + switch penalty
            const priceScale = 100000; // logging uses raw/100000 => raw units are 1e-5 EUR/kWh
            // ================================================================
            // HP vs Gas Selection: Energy-Budget Mode (Always Active)
            // ================================================================
            // Will be calculated after Q_demand is ready (Step 1.5 below)
            // ================================================================

            // ================================================================
            // DEMAND-SUPPLY SCHEDULING ALGORITHM
            // ================================================================
            // Rooms are price-aware: charge signal adjusts their demand forecasts.
            // mpc-house aggregates price-adjusted room demands and supplies them,
            // choosing HP/gas source and enforcing constraints.
            // ================================================================

            const avgTout = ToutArr.reduce((a, b) => a + b, 0) / S;
            const avgWind = windArr.reduce((a, b) => a + b, 0) / S;
            const minPowerThreshold = 0.3; // kW -- below this, slot is considered "no heating"

            // Step 1: Per-slot demand baseline -- prefer aggregated room forecasts, fall back to building model
            const Q_demand = new Array(S);
            let demandSource = "building-model";
            const roomForecasts = node.context().global.get("roomForecasts") || {};
            const healthyRooms = [];
            const staleThresholdMs = 2 * 3600 * 1000;
            const now = Date.now();

            for (const [rName, rData] of Object.entries(roomForecasts)) {
                if (!rData || !rData.healthy) continue;
                if (now - rData.timestamp > staleThresholdMs) continue;
                if (!Array.isArray(rData.Q_demand) || rData.Q_demand.length === 0) continue;
                healthyRooms.push(rData);
            }

            if (healthyRooms.length > 0) {
                demandSource = `rooms(${healthyRooms.length})`;
                for (let k = 0; k < S; k++) {
                    let sum = 0;
                    const mpcSlotTs = baseSlot + k * slotDurationUsed;
                    for (const room of healthyRooms) {
                        const rIdx = Math.floor((mpcSlotTs - room.baseSlot) / room.stepSec);
                        if (rIdx >= 0 && rIdx < room.Q_demand.length) {
                            sum += room.Q_demand[rIdx];
                        } else if (rIdx >= room.Q_demand.length && room.Q_demand.length > 0) {
                            sum += room.Q_demand[room.Q_demand.length - 1];
                        }
                    }
                    Q_demand[k] = Math.max(0, sum);
                }
            } else {
                log(`[mpc-house:${node.name}] No healthy room forecasts -- building model, date mean ${heatLeadH.toFixed(0)}h ahead`);
                for (let k = 0; k < S; k++) {
                    const ToutBal = toutBalanceAt(baseSlot + k * slotDurationUsed, ToutArr[k]);
                    const Uenv_k = Uenv_base + k_temp * Math.max(0, Tbalance_model - ToutBal) + k_wind * (windArr[k] || 0);
                    Q_demand[k] = Math.max(0, Uenv_k * (TsetUsed - ToutBal) - Q_internal);
                }
            }

            // Apply learned demand scale to correct systematic over/under-estimation
            if (demandScale !== 1.0) {
                for (let k = 0; k < S; k++) Q_demand[k] *= demandScale;
            }

            const avgDemand = Q_demand.reduce((a, b) => a + b, 0) / S;
            const maxDemand = Math.max(...Q_demand);
            const E_demand = Q_demand.reduce((a, b) => a + b, 0) * slotHours;

            // The 96 h lead decides whether to charge. Equilibrium indoor temperature
            // for the led date mean is Tout + Q_internal/Uenv. This plan stores only
            // the hold over its own hours, Uenv * fall * hours, not the whole Ci * fall
            // reservoir. demandScale is not applied to this charge.
            const CHARGE_SPREAD_KW = 8;
            let leadCharge = false;
            let chargeKwCap = 0;
            let E_budget = E_demand;
            const toutLedNow = toutBalanceAt(baseSlot, ToutArr.length ? ToutArr[0] : NaN);
            if (Number.isFinite(toutLedNow) && toutLedNow < Tbalance_model && Uenv_base > 0) {
                const qInt = Number.isFinite(Q_internal) && Q_internal > 0 ? Q_internal : Uenv_base * Math.max(0, 20 - Tbalance_model);
                const tiEq = toutLedNow + qInt / Uenv_base;
                const fallK = Math.max(0, TsetUsed - tiEq);
                const planHours = S * slotHours;
                const holdKw = Uenv_base * fallK;
                const E_charge = holdKw * planHours;
                if (E_charge > 0) {
                    E_budget = E_charge;
                    leadCharge = true;
                    chargeKwCap = CHARGE_SPREAD_KW;
                    const fullStore = Ci > 0 ? Ci * fallK : 0;
                    log(
                        `[mpc-house:${node.name}] Lead charge: mean ${heatLeadH.toFixed(0)}h ahead=${toutLedNow.toFixed(1)}C ` +
                            `balance=${Tbalance_model}C eq=${tiEq.toFixed(1)}C fall=${fallK.toFixed(1)}K ` +
                            `hold=${holdKw.toFixed(1)}kW x ${planHours.toFixed(1)}h E=${E_charge.toFixed(0)}kWh ` +
                            `(full store ${fullStore.toFixed(0)}kWh not used)`
                    );
                }
            }

            // Quick check: no heating needed?
            // Read heating decision from comfort-manager (via flow context)
            // A lead charge still runs when the rooms are currently on setpoint.
            const heatingRequired = node.context().flow.get("heatingRequired");
            const noHeatingNeeded = (heatingRequired === 0 || heatingRequired === false) && !leadCharge;

            const comfortSource = typeof heatingRequired === "number" ? "comfort-manager" : "not-available";
            log(
                `[mpc-house:${node.name}] Demand baseline [${demandSource}]: avg=${avgDemand.toFixed(1)}kW max=${maxDemand.toFixed(1)}kW E_loss=${E_demand.toFixed(0)}kWh E_budget=${E_budget.toFixed(0)}kWh scale=${demandScale.toFixed(3)} | comfort check [${comfortSource}]: heatingRequired=${heatingRequired} -> ${noHeatingNeeded ? "NO HEATING NEEDED" : leadCharge ? "LEAD CHARGE" : "heating required"}`
            );

            // Step 1.5: Energy-budget HP allocation (block-aware, minimize total cost)
            // Find continuous blocks in TIME order, sort by total cost, allocate until budget met
            const E_demand_total = E_budget;
            let E_allocated = 0;
            const hpAllocatedSlots = new Set();

            // HP forbidden when electricity heat price >= gas heat price (hard constraint)
            const hpForbidden = new Array(S).fill(false);
            let forbiddenCount = 0;
            for (let s = 0; s < S; s++) {
                if (safeElecPrice(s) >= safeGasPrice(s)) {
                    hpForbidden[s] = true;
                    forbiddenCount++;
                }
            }
            if (forbiddenCount > 0) debug(`[mpc-house:${node.name}] HP forbidden in ${forbiddenCount}/${S} slots (elec >= gas price)`);

            // A lead charge is spread at floor power across the cheap hours.
            // If those hours cannot hold the energy at 8 kW, use full HP capacity.
            if (leadCharge && chargeKwCap > 0) {
                let ok = 0;
                for (let s = 0; s < S; s++) {
                    if (hp_capacity[s] > 0.5 && !hpForbidden[s]) ok++;
                }
                const eligibleHours = ok * slotHours;
                const hoursNeeded = CHARGE_SPREAD_KW > 0 ? E_budget / CHARGE_SPREAD_KW : 0;
                if (eligibleHours < hoursNeeded) {
                    log(
                        `[mpc-house:${node.name}] Lead charge window ${eligibleHours.toFixed(1)}h < ${hoursNeeded.toFixed(1)}h at ${CHARGE_SPREAD_KW}kW -- using HP capacity`
                    );
                    chargeKwCap = 0;
                } else {
                    log(
                        `[mpc-house:${node.name}] Lead charge spread ${E_budget.toFixed(0)}kWh over cheapest ${hoursNeeded.toFixed(1)}h at ${CHARGE_SPREAD_KW}kW`
                    );
                }
            }

            // Helper: calculate energy and cost for a slot.
            // Lead charge uses the floor power (8 kW) so the run is not a trickle.
            // Otherwise one slot is a full HP capacity block.
            const calcSlotEnergy = (s) => {
                let maxCapacity = Math.min(hp_capacity[s], Q_distribution);
                if (chargeKwCap > 0) maxCapacity = Math.min(maxCapacity, chargeKwCap);
                return maxCapacity * slotHours;
            };

            // ================================================================
            // PRICE-FIRST SLOT SELECTION
            // ================================================================
            // 1. Rank all HP-capable non-forbidden slots by electricity price
            // 2. Greedily select cheapest slots until energy budget is met
            // 3. Extract runs of consecutive selected slots
            // 4. Runs shorter than minBlock: extend with adjacent HP-capable
            //    slots (even if slightly more expensive) or drop entirely
            // 5. Bridge single-slot gaps to avoid micro on/off/on cycling
            // 6. Fallback: if budget still not met after drops, top up with
            //    the next cheapest unallocated valid runs
            // ================================================================
            const minBlockSlots = Math.max(1, Math.ceil(1800 / slotDurationUsed)); // 30-min minimum
            debug(
                `[mpc-house:${node.name}] === PRICE-FIRST ALLOCATION === E_demand=${E_demand_total.toFixed(1)}kWh minBlock=${minBlockSlots} slots (${((minBlockSlots * slotDurationUsed) / 60).toFixed(0)}min)`
            );

            // Helper: slot is usable by HP
            const isHpOk = (s) => s >= 0 && s < S && hp_capacity[s] > 0.5 && !hpForbidden[s];

            // Step 1: collect and rank eligible slots by electricity price
            const eligibleSlots = [];
            for (let s = 0; s < S; s++) {
                if (isHpOk(s)) eligibleSlots.push({ s, price: safeElecPrice(s), energy: calcSlotEnergy(s) });
            }
            eligibleSlots.sort((a, b) => a.price - b.price);

            // Step 2: greedy selection -- cheapest first until budget met
            const selectedSlots = new Set();
            let E_selected = 0;
            for (const { s, energy } of eligibleSlots) {
                if (E_selected >= E_demand_total) break;
                selectedSlots.add(s);
                E_selected += energy;
            }
            debug(`[mpc-house:${node.name}] Price-first: selected ${selectedSlots.size}/${eligibleSlots.length} eligible slots, E_selected=${E_selected.toFixed(1)}kWh`);

            // Step 3: extract runs of consecutive selected slots
            const extractRuns = (slotSet) => {
                const sorted = [...slotSet].sort((a, b) => a - b);
                const runs = [];
                let run = [];
                for (const s of sorted) {
                    if (run.length === 0 || s === run[run.length - 1] + 1) {
                        run.push(s);
                    } else {
                        runs.push(run);
                        run = [s];
                    }
                }
                if (run.length > 0) runs.push(run);
                return runs;
            };

            // Step 4: enforce minimum block length -- extend or drop
            const finalAllocated = new Set();
            const seedRuns = extractRuns(selectedSlots);
            let extendedRuns = 0;
            let droppedRuns = 0;
            for (const run of seedRuns) {
                if (run.length >= minBlockSlots) {
                    for (const s of run) finalAllocated.add(s);
                } else {
                    // Try to reach minBlock by expanding toward nearest HP-ok neighbors
                    const ext = [...run];
                    let lo = ext[0] - 1;
                    let hi = ext[ext.length - 1] + 1;
                    while (ext.length < minBlockSlots) {
                        const canLo = isHpOk(lo);
                        const canHi = isHpOk(hi);
                        if (!canLo && !canHi) break;
                        // Prefer the cheaper neighbor
                        const pickLo = canLo && (!canHi || safeElecPrice(lo) <= safeElecPrice(hi));
                        if (pickLo) {
                            ext.unshift(lo--);
                        } else {
                            ext.push(hi++);
                        }
                    }
                    if (ext.length >= minBlockSlots) {
                        for (const s of ext) finalAllocated.add(s);
                        extendedRuns++;
                        debug(`[mpc-house:${node.name}] Extended short run [${run[0]}..${run[run.length - 1]}] -> [${ext[0]}..${ext[ext.length - 1]}]`);
                    } else {
                        droppedRuns++;
                        debug(`[mpc-house:${node.name}] Dropped isolated run [${run[0]}..${run[run.length - 1]}] (${run.length} slots, no valid neighbors)`);
                    }
                }
            }

            // Step 5: bridge single-slot gaps to prevent micro off/on/off
            const sortedFinal = [...finalAllocated].sort((a, b) => a - b);
            let bridgeCount = 0;
            for (let i = 0; i < sortedFinal.length - 1; i++) {
                const gap = sortedFinal[i + 1] - sortedFinal[i] - 1;
                if (gap === 1) {
                    const g = sortedFinal[i] + 1;
                    if (isHpOk(g) && !finalAllocated.has(g)) {
                        finalAllocated.add(g);
                        bridgeCount++;
                    }
                }
            }
            if (bridgeCount > 0) debug(`[mpc-house:${node.name}] Bridged ${bridgeCount} single-slot gap(s)`);

            // Step 6: fallback top-up if drops caused a significant shortfall
            E_allocated = 0;
            for (const s of finalAllocated) E_allocated += calcSlotEnergy(s);
            if (E_allocated < E_demand_total * 0.9 && eligibleSlots.length > 0) {
                debug(`[mpc-house:${node.name}] Shortfall after drops (${E_allocated.toFixed(1)} < ${(E_demand_total * 0.9).toFixed(1)}kWh) -- top-up pass`);
                // Add cheapest not-yet-allocated eligible slots in minBlock-sized batches
                const notYet = eligibleSlots.filter(({ s }) => !finalAllocated.has(s));
                for (let i = 0; i <= notYet.length - minBlockSlots && E_allocated < E_demand_total; i++) {
                    // Only add if this forms or extends a valid run
                    const s = notYet[i].s;
                    const adjacent = finalAllocated.has(s - 1) || finalAllocated.has(s + 1);
                    if (adjacent || (isHpOk(s - 1) && isHpOk(s + 1))) {
                        finalAllocated.add(s);
                        E_allocated += notYet[i].energy;
                    }
                }
            }

            // Commit
            hpAllocatedSlots.clear();
            for (const s of finalAllocated) hpAllocatedSlots.add(s);
            E_allocated = 0;
            for (const s of hpAllocatedSlots) E_allocated += calcSlotEnergy(s);
            debug(
                `[mpc-house:${node.name}] === ALLOCATION COMPLETE === Slots: ${hpAllocatedSlots.size}, Energy: ${E_allocated.toFixed(1)}kWh (demand=${E_demand_total.toFixed(1)}kWh, extended=${extendedRuns}, dropped=${droppedRuns})`
            );

            // Set initial hpPreferred based on HP allocation
            for (let s = 0; s < S; s++) {
                hpPreferred[s] = hpAllocatedSlots.has(s) && hp_capacity[s] > 0.5;
            }

            const hpSlotCount = hpAllocatedSlots.size;

            // Comfort-optimized gas placement: centre-fill in forbidden gaps, longest gap first.
            // Gaps are forbidden HP slots (elec >= gas price). Coast slots (non-forbidden, non-HP)
            // are not candidates for gas -- HP demand was already satisfied without them.
            const E_remaining = E_demand_total - E_allocated;
            let gasSlotCount = 0;
            const gasAllocatedSlots = new Set();

            if (E_remaining > 0.5 && Qmax_gas > 0.5) {
                // Find forbidden gaps (consecutive forbidden slots)
                const gaps = [];
                let gapStart = null;
                for (let s = 0; s <= S; s++) {
                    const forbidden = s < S && hpForbidden[s];
                    if (forbidden && gapStart === null) {
                        gapStart = s;
                    } else if (!forbidden && gapStart !== null) {
                        gaps.push({ start: gapStart, end: s - 1 });
                        gapStart = null;
                    }
                }
                if (gapStart !== null) gaps.push({ start: gapStart, end: S - 1 });

                if (gaps.length === 0) {
                    debug(`[mpc-house:${node.name}] No forbidden gaps available for gas -- emergency HP override needed`);
                } else {
                    // Precompute fill order per gap: slots sorted nearest-to-centre first
                    const gapState = gaps.map((g) => {
                        const mid = (g.start + g.end) / 2;
                        const order = [];
                        for (let s = g.start; s <= g.end; s++) order.push(s);
                        order.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
                        return { ...g, order, ptr: 0 };
                    });

                    let E_gas = 0;
                    let active = true;
                    while (E_gas < E_remaining - 0.1 && active) {
                        active = false;
                        // Remaining unallocated slots per gap
                        const rem = gapState.map((g) => g.order.length - g.ptr);
                        const maxRem = Math.max(...rem);
                        if (maxRem <= 0) break;
                        // Fill one slot from each gap tied for the most remaining unfilled slots
                        for (let gi = 0; gi < gapState.length; gi++) {
                            if (E_gas >= E_remaining - 0.1) break;
                            if (rem[gi] < maxRem) continue; // skip shorter gaps this round
                            const g = gapState[gi];
                            if (g.ptr >= g.order.length) continue;
                            const slot = g.order[g.ptr++];
                            gasAllocatedSlots.add(slot);
                            E_gas += Math.min(Q_demand[slot], Qmax_gas, Q_distribution) * slotHours;
                            active = true;
                        }
                    }
                    gasSlotCount = gasAllocatedSlots.size;
                    debug(
                        `[mpc-house:${node.name}] Gas centre-fill: E_remaining=${E_remaining.toFixed(1)}kWh E_gas=${E_gas.toFixed(1)}kWh gas_slots=${gasSlotCount} gaps=${gaps.length}`
                    );

                    // Emergency: if gas still can't cover shortfall, allow cheapest forbidden HP slots
                    if (E_gas < E_remaining - 0.5) {
                        const emergency = [];
                        for (let s = 0; s < S; s++) if (hpForbidden[s] && !gasAllocatedSlots.has(s) && hp_capacity[s] > 0.5) emergency.push(s);
                        emergency.sort((a, b) => safeElecPrice(a) - safeElecPrice(b));
                        let E_emerg = 0;
                        for (const s of emergency) {
                            if (E_emerg >= E_remaining - E_gas - 0.1) break;
                            hpPreferred[s] = true;
                            E_emerg += Math.min(Q_demand[s], hp_capacity[s], Q_distribution) * slotHours;
                            node.warn(`[mpc-house:${node.name}] Emergency HP override s=${s} (elec=${safeElecPrice(s).toFixed(1)} >= gas=${safeGasPrice(s).toFixed(1)})`);
                        }
                    }
                }
            }

            debug(
                `[mpc-house:${node.name}] Energy-budget summary: E_demand=${E_demand_total.toFixed(0)}kWh ` +
                    `E_hp=${E_allocated.toFixed(0)}kWh E_gas=${E_remaining > 0 ? E_remaining.toFixed(0) : 0}kWh -> ` +
                    `HP_slots=${hpSlotCount} gas_slots=${gasSlotCount} coast_slots=${S - hpSlotCount - gasSlotCount}`
            );

            debug(
                `[mpc-house:${node.name}] HP capacity range: ${min_hp_capacity.toFixed(1)}-${Qmax_hp.toFixed(1)}kW, avg=${avg_hp_capacity.toFixed(1)}kW, low_cap_slots=${slots_with_low_capacity}`
            );

            // Step 2: Use pre-calculated heat costs from calendar for charge signal
            // priceElecArr and priceGasArr are already heat prices (cent/MWh), not electricity prices
            const heatCostPerSlot = new Array(S);
            for (let i = 0; i < S; i++) {
                // Use whichever source is preferred (already accounts for COP, efficiency)
                heatCostPerSlot[i] = hpPreferred[i] ? safeElecPrice(i) : safeGasPrice(i);
            }

            // Step 3: Compute and publish charge signal for rooms (price-based FF)
            const minCost = Math.min(...heatCostPerSlot.filter(Number.isFinite));
            const maxCost = Math.max(...heatCostPerSlot.filter(Number.isFinite));
            const midCost = (minCost + maxCost) / 2;
            const halfRange = (maxCost - minCost) / 2;
            const chargeAdj = heatCostPerSlot.map((c) => {
                if (halfRange < 0.001 || !Number.isFinite(midCost)) return 0;
                const deviation = -(c - midCost) / halfRange;
                const v = clamp(deviation, -1, 1) * chargeMaxDeg;
                return Number.isFinite(v) ? v : 0;
            });
            node.context().global.set("chargeSignal", {
                baseSlot,
                stepSec: slotDurationUsed,
                adj: chargeAdj,
                maxDeg: chargeMaxDeg,
                timestamp: Date.now()
            });
            const chargeNow = chargeAdj[0] || 0;
            debug(
                `[mpc-house:${node.name}] Charge signal: chargeMax=${chargeMaxDeg}degC costRange=${minCost.toFixed(3)}..${maxCost.toFixed(3)} chargeNow=${chargeNow >= 0 ? "+" : ""}${chargeNow.toFixed(2)}degC`
            );

            // Step 4: Chosen slots charge the building at source capacity.
            // How many slots is set by the energy that must be stored.
            // The run is not scaled down to that hour's heat loss.
            let hp_ena = new Array(S).fill(0);
            let gas_ena = new Array(S).fill(0);
            let Q = new Array(S).fill(0);

            if (!noHeatingNeeded) {
                for (let i = 0; i < S; i++) {
                    const useHp = hpPreferred[i];
                    const useGas = gasAllocatedSlots.has(i);

                    if (!useHp && !useGas) {
                        Q[i] = 0;
                        continue;
                    }

                    let capAtSlot = useHp ? hp_capacity[i] : Qmax_gas;
                    if (useHp && chargeKwCap > 0) capAtSlot = Math.min(capAtSlot, chargeKwCap);
                    Q[i] = Math.min(capAtSlot, Q_distribution);
                    if (Q[i] > minPowerThreshold) {
                        if (useHp && hp_capacity[i] > 0.5) {
                            hp_ena[i] = 1;
                        } else if (useGas) {
                            gas_ena[i] = 1;
                        }
                    } else {
                        Q[i] = 0;
                    }
                }
            }

            // Step 5: Validate with thermal simulation
            let lastSim = simulate(TfUsed, Ti, ToutArr, windArr, Q);

            // Note: No backfill needed - energy-budget allocation already ensures comfort
            // If simulation shows minT < Tmin, it indicates model mismatch, not allocation error
            if (lastSim.minT < Tmin) {
                debug(`[mpc-house:${node.name}] WARNING: Simulated minT=${lastSim.minT.toFixed(1)}degC < Tmin=${Tmin.toFixed(1)}degC (possible model error)`);
            }

            // Step 6: Enforce minimum HP block length (prevent short cycling)
            // Use 30-min minimum (2 slots @ 15min) as fallback if 60-min causes excessive waste
            const minHpEventSlots = Math.max(1, Math.ceil(1800 / slotDurationUsed)); // 30 min minimum
            debug(`[mpc-house:${node.name}] === MIN BLOCK FILTER === minHpEventSlots=${minHpEventSlots} (${((minHpEventSlots * slotDurationUsed) / 60).toFixed(0)} min)`);
            if (minHpEventSlots > 1) {
                let shortRunsRemoved = 0;
                let totalSlotsRemoved = 0;
                let s = 0;
                while (s < S) {
                    if (hp_ena[s] === 1) {
                        let runStart = s;
                        let runLen = 0;
                        while (s < S && hp_ena[s] === 1) {
                            runLen++;
                            s++;
                        }
                        if (runLen < minHpEventSlots) {
                            debug(
                                `[mpc-house:${node.name}] Removing short HP run: slots ${runStart}-${runStart + runLen - 1} (${runLen} slots = ${((runLen * slotDurationUsed) / 60).toFixed(0)} min)`
                            );
                            for (let i = runStart; i < runStart + runLen; i++) {
                                hp_ena[i] = 0;
                                hpAllocatedSlots.delete(i);
                                // Do NOT auto-assign to gas - respect energy-budget
                            }
                            shortRunsRemoved++;
                            totalSlotsRemoved += runLen;
                        }
                    } else {
                        s++;
                    }
                }
                if (shortRunsRemoved > 0) {
                    debug(
                        `[mpc-house:${node.name}] Min-block filter removed ${shortRunsRemoved} runs (${totalSlotsRemoved} slots total). Remaining HP slots: ${hpAllocatedSlots.size}`
                    );
                    lastSim = simulate(TfUsed, Ti, ToutArr, windArr, Q);
                }
            }

            // Step 7: Compute supply target from near-term average Q_plan
            let T_supply_curve = null;
            let heatingCurveRatio = 0;
            if (Number.isFinite(hpSetpointHilim) && hpSetpointHilim > TsetUsed && Q_distribution > 0) {
                const nearHourSlots = Math.min(Math.max(1, Math.round((3 * 3600) / slotDurationUsed)), S);
                const Q_avg_near = Q.slice(0, nearHourSlots).reduce((a, b) => a + b, 0) / nearHourSlots;
                heatingCurveRatio = Math.min(1, Q_avg_near / Q_distribution);
                T_supply_curve = TsetUsed + (hpSetpointHilim - TsetUsed) * heatingCurveRatio;
                debug(
                    `[mpc-house:${node.name}] Supply target: Q_avg_near=${Q_avg_near.toFixed(1)}kW ratio=${heatingCurveRatio.toFixed(2)} T_supply=${T_supply_curve.toFixed(1)}degC`
                );

                // Apply price-based charge to supply target -- cheap hours: raise supply so
                // floors can actually absorb the extra heat; expensive hours: lower supply so
                // HP backs off. Uses the same chargeAdj[0] as the floor setpoint adjustment,
                // making HP power inversely proportional to electricity price.
                if (supplyChargeEnabled && chargeMaxDeg > 0) {
                    const chargeNow = chargeAdj[0] || 0;
                    const supplyBefore = T_supply_curve;
                    const loLim = hpSetpointLolim != null ? hpSetpointLolim : 20;
                    const hiLim = hpSetpointHilim != null ? hpSetpointHilim : 55;
                    T_supply_curve = Math.max(loLim, Math.min(hiLim, T_supply_curve + chargeNow));
                    debug(
                        `[mpc-house:${node.name}] Supply charge: chargeNow=${chargeNow >= 0 ? "+" : ""}${chargeNow.toFixed(1)}degC -> supply ${supplyBefore.toFixed(1)}->${T_supply_curve.toFixed(1)}degC`
                    );
                }
            }

            // Log COP/capacity summary for first slot
            const Tout_now = ToutArr[0] || 0;
            const hp_cap_now = getHpCapacityAtTemp(Tout_now);
            const cop_now = getCopAtTemp(Tout_now, hp_cap_now);
            debug(
                `[mpc-house:${node.name}] HP capacity: Tout=${Tout_now.toFixed(1)}degC COP=${cop_now.toFixed(2)} -> ${hp_cap_now.toFixed(1)}kW (nominal ${Qmax_hp}kW @ ${copT2}degC)`
            );

            const fmtSlotTs = (ts) => new Date(ts * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
            const slotsToShow = Math.min(12 * slotsPerHourUsed, S);
            debug(`[mpc-house:${node.name}] Schedule result (first ${slotsToShow} slots):`);
            for (let s = 0; s < slotsToShow; s++) {
                const slotTs = baseSlot + s * slotDurationUsed;
                const hpOn = hp_ena[s] === 1 ? "HP" : "--";
                const gasOn = gas_ena[s] === 1 ? "GAS" : "---";
                const pref = hpPreferred[s] ? "pref:HP" : gasAllocatedSlots.has(s) ? "pref:GAS" : "pref:NONE";
                const qd = Q_demand[s] || 0;
                const ca = chargeAdj[s] || 0;
                debug(
                    `  ${fmtSlotTs(slotTs)} (s=${s}): Q_dem=${qd.toFixed(1)} Q_plan=${Q[s].toFixed(1)}kW charge=${ca >= 0 ? "+" : ""}${ca.toFixed(2)}degC | ${hpOn} ${gasOn} | ${pref}`
                );
            }

            // Max power in next 12 hours -- sent to hp-control via schedule context for setpoint calculation
            let P_max_12h = null;
            if (Q && Q.length > 0) {
                const horizonSlots = Math.min(12, Q.length);
                P_max_12h = Math.max(...Q.slice(0, horizonSlots));
            }

            const schedule = {
                baseSlot: baseSlot,
                slotDurationUsed: slotDurationUsed,
                Q: Q,
                allow: Q.map((q) => (q !== 0 ? 1 : 0)),
                hp_ena: hp_ena,
                gas_ena: gas_ena,
                Tf_pred: lastSim.Tf_pred,
                Ti_pred: lastSim.Ti_pred,
                Tmin: Tmin,
                Tmax: Tmax,
                Tset: TsetUsed,
                Ti_now: Ti,
                Tf_now: TfUsed,
                timestamp: Date.now(),
                bandLowEffective: bandLowEffective,
                bandHighEffective: bandHighEffective,
                bandLowAdjustment: bandLowAdjustment,
                bandHighAdjustment: bandHighAdjustment,
                P_max_12h: P_max_12h
            };
            schedule.priceElecBase = priceElecArr.slice(0, S);
            schedule.priceGasBase = priceGasArr.slice(0, S);

            // plan_heat is the charge kW. plan_elec and hp_ena kWh are the electrical side of that charge.
            const planHeat = Q.map((q) => parseFloat((q || 0).toFixed(2)));
            const planElec = Q.map((q, s) => {
                if (hp_ena[s] !== 1 || q <= 0) return 0;
                const tout = ToutArr[s] != null ? ToutArr[s] : ToutArr[0] || 0;
                const cop = getCopAtTemp(tout, q);
                return cop > 0 ? parseFloat((q / cop).toFixed(2)) : 0;
            });
            const qGasHeat = gas_ena.map((on, h) => (on ? Q[h] : 0));

            lastTout = ToutArr.length > 0 ? ToutArr[0] : null;
            lastTsetUsed = TsetUsed;

            if (fullRecalc && (hpScheduleTitle || gasScheduleTitle) && send) {
                writeSchedules(hp_ena, gas_ena, planElec, qGasHeat, send, slotDurationUsed, planHeat, planElec).catch((e) => {
                    node.error(`[mpc-house:${node.name}] Error writing schedules: ${e.message}`);
                });
            } else if (!fullRecalc) {
                debug(`[mpc-house:${node.name}] Adjustment only, schedule not written to calendar`);
            }

            // Store schedule in context. Floors read hpChargePlan to force valves open in cheap slots.
            node.context().set("schedule", schedule);
            node.context().global.set("hpChargePlan", {
                baseSlot: schedule.baseSlot,
                stepSec: schedule.slotDurationUsed != null ? schedule.slotDurationUsed : slotDuration,
                hp_ena: Array.isArray(schedule.hp_ena) ? schedule.hp_ena.slice() : [],
                timestamp: Date.now()
            });

            // Store prediction for next validation (hour 1 = next hour)
            if (enableAdaptiveFeedback && lastSim.Ti_pred.length > 0) {
                Ti_pred_last = lastSim.Ti_pred[0]; // Prediction for next hour
                timestamp_last = Date.now();
            }

            const nowSec = Math.floor(Date.now() / 1000);
            const schedSlotDuration = schedule.slotDurationUsed != null ? schedule.slotDurationUsed : slotDuration;
            const slotIndex = Math.min(Math.max(0, Math.floor((nowSec - schedule.baseSlot) / schedSlotDuration)), schedule.allow.length - 1);
            const heating_allowed = schedule.allow[slotIndex] || 0;
            Q_planned_last = schedule.Q[slotIndex] || 0;

            // Calculate power efficiency (if power inputs available)
            const Q_floor = Q_floor_actual !== null ? Q_floor_actual : 0;
            const Q_air = Q_air_actual !== null ? Q_air_actual : 0;
            const Q_total = Q_floor + Q_air;
            const efficiency = Q_planned_last > 0 ? (Q_total / Q_planned_last) * 100 : 0;

            // Demand learning: on each tick, compare actual vs planned instantaneous power.
            // Uses a rolling 48-slot buffer to derive a long-run ratio (demandScale).
            // Only learn from slots where heating was actively planned (>0.5 kW) and sensor is valid.
            const DEMAND_LEARN_MIN_PLANNED_KW = 0.5;
            if (Q_planned_last > DEMAND_LEARN_MIN_PLANNED_KW && Q_floor_actual !== null) {
                demandLearningBuffer.push({ E_actual: Q_total, E_planned: Q_planned_last });
                if (demandLearningBuffer.length > DEMAND_LEARN_MAX_SLOTS) demandLearningBuffer.shift();
                if (demandLearningBuffer.length >= 3) {
                    const sumA = demandLearningBuffer.reduce((s, e) => s + e.E_actual, 0);
                    const sumP = demandLearningBuffer.reduce((s, e) => s + e.E_planned, 0);
                    demandScale = Math.max(0.2, Math.min(1.5, sumA / sumP));
                    log(
                        `[mpc-house:${node.name}] Demand scale=${demandScale.toFixed(3)} (${demandLearningBuffer.length} slots, actual=${sumA.toFixed(1)} planned=${sumP.toFixed(1)})`
                    );
                }
            }

            // Calculate model error (if prediction available)
            const model_error = Ti_pred_last !== null ? Ti - Ti_pred_last : 0;
            const activeBank = selectAutotuneBank(Q_planned_last, autotuneStoreRaw.lastBank);
            const previousBank = autotuneStoreRaw.lastBank;
            autotuneStoreRaw.lastBank = activeBank;
            if (previousBank !== activeBank) {
                debug(`[mpc-house:${node.name}] autotune bank switched: ${previousBank} -> ${activeBank}`);
            }
            if (Number.isFinite(model_error)) {
                const bankHistory = autotuneStoreRaw[activeBank].errorHistory;
                bankHistory.push({ error: model_error, timestamp: Date.now() });
                if (bankHistory.length > MAX_ERROR_HISTORY) bankHistory.shift();
            }
            const { underRatio, overRatio, samples } = getErrorRatios(autotuneStoreRaw[activeBank].errorHistory);
            const coverage = S > 0 ? Math.min(priceElecArr.length, priceGasArr.length, ToutArr.length, windArr.length) / S : 0;
            const forecastTrust = clamp01(coverage);
            const samplesScore = clamp01(samples / 6);
            const tiOk = Number.isFinite(Ti) ? 1 : 0;
            const qualityPct = Math.round(100 * (tiOk * 0.4 + forecastTrust * 0.3 + samplesScore * 0.3));
            const calendarMissingOrInvalid = priceElecArr.length < S || priceGasArr.length < S ? 1 : 0;
            const forecastMissingOrInvalid = ToutArr.length < S || windArr.length < S ? 1 : 0;
            const forecastTrustLow = forecastTrust < 0.5 ? 1 : 0;
            const bankHistory = autotuneStoreRaw[activeBank].errorHistory;
            const lastErrorTs = samples > 0 ? bankHistory[bankHistory.length - 1].timestamp : null;
            const staleDataFreeze = lastErrorTs == null ? 1 : Date.now() - lastErrorTs > 2 * 3600000 ? 1 : 0;
            staleDataFreezeState = staleDataFreeze;
            const canApplyLearning =
                autotuneModeCode === 2 && qualityPct >= 60 && calendarMissingOrInvalid === 0 && forecastMissingOrInvalid === 0 && forecastTrustLow === 0 && staleDataFreeze === 0;
            if (canApplyLearning) {
                const age = getLearningAgeSec(nowSec, autotuneStoreRaw[activeBank].lastApplySec);
                if (age >= 3600 || autotuneStoreRaw[activeBank].lastApplySec == null) {
                    autotuneStoreRaw[activeBank].lastApplySec = nowSec;
                }
            }
            nodeContext.set("autotuneStore", autotuneStoreRaw);
            saveState(); // persist adaptive state after full optimisation run

            // === Publish to iolayer datastreams (using array payloads) ===
            const messages = [];

            // Temperature datastream: 5 members (.1=Ti .2=Ti_pred .3=Tset .4=Tmin .5=Tmax)
            if (outTempTopic) {
                const Ti_pred_now = lastSim.Ti_pred.length > 0 ? lastSim.Ti_pred[0] : Ti;
                messages.push({
                    topic: outTempTopic,
                    payload: [
                        parseFloat(Ti.toFixed(2)),
                        parseFloat(Ti_pred_now.toFixed(2)),
                        parseFloat(TsetUsed.toFixed(2)),
                        parseFloat(Tmin.toFixed(2)),
                        parseFloat(Tmax.toFixed(2))
                    ]
                });
            }

            // Power datastream: 2 members (.1=Q_plan_total .2=Q_actual_total)
            if (outPowerTopic) {
                messages.push({
                    topic: outPowerTopic,
                    payload: [parseFloat(Q_planned_last.toFixed(2)), parseFloat(Q_total.toFixed(2))]
                });
            }

            // Unitless datastream: 8 members (autotune placeholders + key unitless runtime metrics)
            // .1 mode(0=off,1=shadow,2=active)
            // .2 efficiency_ratio (Q_actual_total/Q_plan_total, 0..2)
            // .3 w_under_eff (placeholder until autotune active)
            // .4 w_trend_eff (placeholder until autotune active)
            // .5 under_ratio (placeholder)
            // .6 over_ratio (placeholder)
            // .7 forecast_trust (placeholder)
            // .8 reserved_for_future_unitless_value
            if (outUnitlessTopic) {
                const efficiencyRatio = Q_planned_last > 0 ? Q_total / Q_planned_last : 0;
                messages.push({
                    topic: outUnitlessTopic,
                    payload: [
                        autotuneModeCode,
                        parseFloat(Math.min(2, Math.max(0, efficiencyRatio)).toFixed(3)),
                        1.0,
                        0.0,
                        parseFloat(underRatio.toFixed(3)),
                        parseFloat(overRatio.toFixed(3)),
                        parseFloat(forecastTrust.toFixed(3)),
                        0
                    ]
                });
            }

            // Flags datastream (MPCGW): 8 members (binary freeze/gate diagnostics)
            // .1 missing_critical_input
            // .2 calendar_missing_or_invalid
            // .3 forecast_missing_or_invalid
            // .4 forecast_trust_low
            // .5 forced_mode_freeze
            // .6 stale_data_freeze
            // .7 safety_clamp_freeze
            // .8 reserved_for_future_binary_flag
            if (outFlagsTopic) {
                const missingCriticalInput = Number.isFinite(Ti) ? 0 : 1;
                messages.push({
                    topic: outFlagsTopic,
                    payload: [missingCriticalInput, calendarMissingOrInvalid, forecastMissingOrInvalid, forecastTrustLow, autotuneModeCode === 2 ? 0 : 1, staleDataFreeze, 0, 0]
                });
            }

            // Learning age datastream (MPCLV): scalar seconds since last learning apply.
            if (outLearningAgeTopic) {
                messages.push({
                    topic: outLearningAgeTopic,
                    payload: getLearningAgeSec(nowSec, autotuneStoreRaw[activeBank].lastApplySec)
                });
            }

            // Learning quality datastream (MPCZV): scalar quality percentage 0..100
            if (outQualityTopic) {
                messages.push({
                    topic: outQualityTopic,
                    payload: qualityPct
                });
            }

            // Control datastream: 2 members (.1=heat_allowed 0-100% .2=efficiency 0-150%)
            if (outControlTopic) {
                messages.push({
                    topic: outControlTopic,
                    payload: [heating_allowed * 100, parseFloat(efficiency.toFixed(1))]
                });
            }

            // Error datastream: 3 members (.1=model_err .2=band_low_adj .3=band_high_adj)
            if (outErrorTopic) {
                messages.push({
                    topic: outErrorTopic,
                    payload: [parseFloat(model_error.toFixed(3)), parseFloat(bandLowAdjustment.toFixed(3)), parseFloat(bandHighAdjustment.toFixed(3))]
                });
            }

            // Heating pair for the heat pump. hp-control writes it only when this
            // full recalc moves it by at least 1 C. Center is the tank temperature
            // that delivers the planned on-slot power through the expected open loops.
            // A half-spread of 4 C (8 C between hi and lo) covers the hours until
            // the next recalc. Tick adjustments do not move the pair.
            if (fullRecalc) {
                const floorK = 0.035;
                const floorReturnC = 21;
                const openLoops = 15;
                const halfSpread = 4;
                const pairMin = 25;
                const pairMax = 55;
                let qSum = 0;
                let qN = 0;
                for (let s = 0; s < S; s++) {
                    if (hp_ena[s] === 1 && Q[s] > minPowerThreshold) {
                        qSum += Q[s];
                        qN++;
                    }
                }
                if (qN > 0) {
                    const qPlan = qSum / qN;
                    const center = floorReturnC + qPlan / (openLoops * floorK);
                    const span = halfSpread * 2;
                    let lo = Math.round(center - halfSpread);
                    let hi = Math.round(center + halfSpread);
                    if (lo < pairMin) {
                        lo = pairMin;
                        hi = lo + span;
                    }
                    if (hi > pairMax) {
                        hi = pairMax;
                        lo = hi - span;
                    }
                    if (lo < pairMin) lo = pairMin;
                    node.context().global.set("hpSetpointPair", {
                        hi: hi,
                        lo: lo,
                        center: Math.round(center * 10) / 10,
                        qKw: Math.round(qPlan * 10) / 10,
                        ts: Date.now()
                    });
                    log(
                        `[mpc-house:${node.name}] HP pair: Q=${qPlan.toFixed(1)}kW loops=${openLoops} ` +
                            `center=${center.toFixed(1)}C -> hi=${hi} lo=${lo}`
                    );
                } else {
                    log(`[mpc-house:${node.name}] HP pair unchanged: no planned HP slots`);
                }
            }

            // Publish supply target for hp-control (which owns setpoint writing)
            if (supplyTargetTopic && T_supply_curve != null) {
                const roomError = Number.isFinite(Ti) && Number.isFinite(TsetUsed) ? Ti - TsetUsed : 0;
                const heatingAdj = T_supply_curve - 0.2 * roomError;
                const val = parseFloat(heatingAdj.toFixed(2));
                if (val !== lastSupplyTarget) {
                    messages.push({ topic: supplyTargetTopic, payload: val });
                    lastSupplyTarget = val;
                }
            }

            // Send all messages and log each one
            for (const m of messages) {
                log(`[mpc-house:${node.name}] -> ${JSON.stringify(m)}`);
                node.send(m);
            }

            // Log power delivery status (if power inputs available)
            if (Q_floor_actual !== null || Q_air_actual !== null) {
                if (Q_planned_last > 0 && Math.abs(efficiency - 100) > 20) {
                    node.warn(`[mpc-house:${node.name}] Power mismatch: planned=${Q_planned_last.toFixed(1)}kW actual=${Q_total.toFixed(1)}kW (${efficiency.toFixed(0)}%)`);
                } else if (Q_planned_last > 0) {
                    debug(`[mpc-house:${node.name}] Power: ${Q_total.toFixed(1)}kW (${efficiency.toFixed(0)}% of ${Q_planned_last.toFixed(1)}kW planned)`);
                }
            }

            const minT = lastSim.minT.toFixed(1);
            const maxT = lastSim.maxT.toFixed(1);
            const adaptiveIndicator =
                Math.abs(bandLowAdjustment) > 0.01 || Math.abs(bandHighAdjustment) > 0.01 ? ` [d${bandLowAdjustment.toFixed(2)},${bandHighAdjustment.toFixed(2)}]` : "";
            const status =
                lastSim.minT < Tmin || lastSim.maxT > Tmax
                    ? { fill: "yellow", text: `WARN Ti ${minT}..${maxT}degC${adaptiveIndicator}` }
                    : { fill: "green", text: `OK Ti ${minT}..${maxT}degC, heat=${heating_allowed}${adaptiveIndicator}` };

            node.status({ ...status, shape: "dot" });

            // Count heating/cooling slots and source usage, convert to hours for display
            const slotsToHours = (slots) => ((slots * schedSlotDuration) / 3600).toFixed(1);
            const activeSlots = schedule.allow.reduce((sum, val) => sum + val, 0);
            const hpSlots = schedule.hp_ena.reduce((sum, val) => sum + val, 0);
            const gasSlots = schedule.gas_ena.reduce((sum, val) => sum + val, 0);
            const bothSlots = schedule.hp_ena.filter((v, i) => v === 1 && schedule.gas_ena[i] === 1).length;
            const coolingSlots = schedule.Q.filter((q) => q < 0).length;
            const heatingSlots = activeSlots - coolingSlots;
            const nextPredTi = lastSim.Ti_pred.length > 0 ? lastSim.Ti_pred[0].toFixed(1) : "N/A";

            const E_plan = schedule.Q.reduce((sum, q) => sum + q * slotHours, 0);
            log(
                `[mpc-house:${node.name}] MPC complete: heating_allowed=${heating_allowed} Q_plan=${Q_planned_last.toFixed(1)}kW | Ti now=${Ti.toFixed(1)}degC pred_next=${nextPredTi}degC | ` +
                    `range ${minT}..${maxT}degC | E_plan=${E_plan.toFixed(0)}kWh ${slotsToHours(heatingSlots)}h heat | HP=${slotsToHours(hpSlots)}h gas=${slotsToHours(gasSlots)}h both=${slotsToHours(bothSlots)}h`
            );
        }

        // ======================================================================
        // MESSAGE HANDLER
        // ======================================================================

        node.on("input", function (msg, send, done) {
            send =
                send ||
                function (m) {
                    node.send(m);
                };

            // Update state from incoming topics (accept number or datastream array/object)
            if (msg.topic === tiTopic && msg.payload != null) {
                const tiVal = parseNumericPayload(msg.payload);
                Ti = tiVal;
                updateTiTrend(tiVal);
            } else if (msg.topic === tfTopic && msg.payload != null) {
                Tf = parseNumericPayload(msg.payload);
            } else if (msg.topic === tsetAvgTopic && msg.payload != null) {
                TsetFromTopic = parseNumericPayload(msg.payload);
            } else if (msg.topic === qFloorActualTopic && msg.payload != null) {
                Q_floor_actual = parseNumericPayload(msg.payload);
                noteActualHeat(Math.floor(Date.now() / 1000));
            } else if (msg.topic === qAirActualTopic && msg.payload != null) {
                Q_air_actual = parseNumericPayload(msg.payload);
            } else if (msg.topic === totalRoomLoadTopic && msg.payload != null) {
                totalRoomLoad = parseNumericPayload(msg.payload);
            } else if (avavwTopic && msg.topic === avavwTopic + ".1" && msg.payload != null) {
                avgValveOpenness = parseFloat(msg.payload);
            } else if (avavwTopic && msg.topic === avavwTopic + ".2" && msg.payload != null) {
                valveGateThreshold = parseFloat(msg.payload);
            } else if (msg.topic === fullRecalcTopic) {
                // Full recalculation (2x daily) -- always run, no throttle
                log(`[mpc-house:${node.name}] FULL RECALC triggered on ${fullRecalcTopic}`);
                runMPC(send, true);
            } else if (msg.topic === triggerTopic) {
                // Tick: run at most every 5 min; all other messages only update cached state above
                const now = Date.now();
                const schedule = node.context().get("schedule");
                const throttleOk = now - lastTickRunTime >= TICK_RUN_THROTTLE_MS;
                if (!schedule) {
                    log(`[mpc-house:${node.name}] No schedule, running full MPC...`);
                    runMPC(send, true);
                    lastTickRunTime = now;
                } else if (throttleOk) {
                    const currentDeviation = Ti !== null && schedule.Ti_now !== null ? Math.abs(Ti - schedule.Ti_now) : 0;
                    const projectedTi = Number.isFinite(Ti) ? Ti + tiTrendSlopeCph * TI_TREND_LOOKAHEAD_H : Ti;
                    const projectedDeviation = Number.isFinite(projectedTi) && schedule.Ti_now !== null ? Math.abs(projectedTi - schedule.Ti_now) : currentDeviation;
                    const trendStrongEnough = Math.abs(tiTrendSlopeCph) >= TI_TREND_MIN_ABS_SLOPE_CPH;
                    const trendWillBreachBand =
                        trendStrongEnough &&
                        Number.isFinite(projectedTi) &&
                        ((Number.isFinite(schedule.Tmax) && projectedTi > schedule.Tmax) || (Number.isFinite(schedule.Tmin) && projectedTi < schedule.Tmin));
                    const trendWillExceedDeviation = trendStrongEnough && projectedDeviation > adjustmentThreshold;
                    const shouldAdjust = currentDeviation > adjustmentThreshold || trendWillBreachBand || trendWillExceedDeviation;
                    if (shouldAdjust) {
                        const reason =
                            currentDeviation > adjustmentThreshold
                                ? `deviation ${currentDeviation.toFixed(2)}degC > ${adjustmentThreshold.toFixed(2)}degC`
                                : `trend slope=${tiTrendSlopeCph.toFixed(2)}degC/h projTi=${Number(projectedTi).toFixed(2)}degC in ${TI_TREND_LOOKAHEAD_H.toFixed(1)}h`;
                        log(`[mpc-house:${node.name}] Tick adjust: ${reason}`);
                        runMPC(send, false);
                    } else {
                        debug(
                            `[mpc-house:${node.name}] Tick: dev=${currentDeviation.toFixed(2)}degC, ` +
                                `trend=${tiTrendSlopeCph.toFixed(2)}degC/h, projDev=${projectedDeviation.toFixed(2)}degC -> publish`
                        );
                        publishCurrentState(send, schedule);
                    }
                    if (!shouldAdjust) extendShortRun(send);
                    lastTickRunTime = now;
                } else {
                    debug(`[mpc-house:${node.name}] Tick throttled (next run in ${Math.ceil((TICK_RUN_THROTTLE_MS - (now - lastTickRunTime)) / 60000)} min)`);
                }
            }

            if (done) done();
        });

        // Publish current state without full recalculation (use current slot, not slot 0)
        function publishCurrentState(send, schedule) {
            if (!schedule || !Number.isFinite(Ti)) return;
            const nowSec = Math.floor(Date.now() / 1000);
            const baseSlot = schedule.baseSlot != null ? schedule.baseSlot : nowSec;
            const schedSlotDuration = schedule.slotDurationUsed != null ? schedule.slotDurationUsed : slotDuration;
            const slotIndex = Math.min(Math.max(0, Math.floor((nowSec - baseSlot) / schedSlotDuration)), (schedule.allow && schedule.allow.length - 1) || 0);
            const heating_allowed = schedule.allow ? schedule.allow[slotIndex] : 0;
            const Q_floor = Q_floor_actual !== null ? Q_floor_actual : 0;
            const Q_air = Q_air_actual !== null ? Q_air_actual : 0;
            const Q_total = Q_floor + Q_air;
            const Q_planned = schedule.Q ? schedule.Q[slotIndex] : 0;
            const efficiency = Q_planned > 0 ? (Q_total / Q_planned) * 100 : 0;
            const model_error = Ti_pred_last !== null ? Ti - Ti_pred_last : 0;
            const activeBank = selectAutotuneBank(Q_planned, autotuneStoreRaw.lastBank);
            autotuneStoreRaw.lastBank = activeBank;
            const bankHistory = autotuneStoreRaw[activeBank].errorHistory;
            const { underRatio, overRatio, samples } = getErrorRatios(bankHistory);
            const forecastTrust = 1.0; // Fallback path uses latest cached schedule; treat forecast trust as nominal
            const samplesScore = clamp01(samples / 6);
            const tiOk = Number.isFinite(Ti) ? 1 : 0;
            const qualityPct = Math.round(100 * (tiOk * 0.4 + forecastTrust * 0.3 + samplesScore * 0.3));
            const staleDataFreeze = staleDataFreezeState;
            nodeContext.set("autotuneStore", autotuneStoreRaw);

            const messages = [];

            // Temperature datastream
            if (outTempTopic) {
                const Ti_pred_now = schedule.Ti_pred && schedule.Ti_pred.length > slotIndex ? schedule.Ti_pred[slotIndex] : Ti;
                messages.push({
                    topic: outTempTopic,
                    payload: [
                        parseFloat(Ti.toFixed(2)),
                        parseFloat(Ti_pred_now.toFixed(2)),
                        parseFloat(schedule.Tset.toFixed(2)),
                        parseFloat(schedule.Tmin.toFixed(2)),
                        parseFloat(schedule.Tmax.toFixed(2))
                    ]
                });
            }

            // Power datastream (2 members: .1=Q_plan_total .2=Q_actual_total)
            if (outPowerTopic) {
                messages.push({
                    topic: outPowerTopic,
                    payload: [parseFloat(Q_planned.toFixed(2)), parseFloat(Q_total.toFixed(2))]
                });
            }

            // Unitless datastream (same layout as runMPC path)
            if (outUnitlessTopic) {
                const efficiencyRatio = Q_planned > 0 ? Q_total / Q_planned : 0;
                messages.push({
                    topic: outUnitlessTopic,
                    payload: [
                        autotuneModeCode,
                        parseFloat(Math.min(2, Math.max(0, efficiencyRatio)).toFixed(3)),
                        1.0,
                        0.0,
                        parseFloat(underRatio.toFixed(3)),
                        parseFloat(overRatio.toFixed(3)),
                        parseFloat(forecastTrust.toFixed(3)),
                        0
                    ]
                });
            }

            // Flags datastream (same layout as runMPC path)
            if (outFlagsTopic) {
                const missingCriticalInput = Number.isFinite(Ti) ? 0 : 1;
                messages.push({
                    topic: outFlagsTopic,
                    payload: [missingCriticalInput, 0, 0, 0, autotuneModeCode === 2 ? 0 : 1, staleDataFreeze, 0, 0]
                });
            }

            // Learning age datastream (same layout as runMPC path)
            if (outLearningAgeTopic) {
                messages.push({
                    topic: outLearningAgeTopic,
                    payload: getLearningAgeSec(nowSec, autotuneStoreRaw[activeBank].lastApplySec)
                });
            }

            if (outQualityTopic) {
                messages.push({
                    topic: outQualityTopic,
                    payload: qualityPct
                });
            }

            // Control datastream
            if (outControlTopic) {
                messages.push({
                    topic: outControlTopic,
                    payload: [heating_allowed * 100, parseFloat(Math.min(200, Math.max(0, efficiency)).toFixed(1))]
                });
            }

            // Error datastream
            if (outErrorTopic) {
                messages.push({
                    topic: outErrorTopic,
                    payload: [parseFloat(model_error.toFixed(2)), parseFloat(bandLowAdjustment.toFixed(2)), parseFloat(bandHighAdjustment.toFixed(2))]
                });
            }

            if (supplyTargetTopic && T_supply_curve != null) {
                const roomError = Number.isFinite(Ti) && Number.isFinite(TsetUsed) ? Ti - TsetUsed : 0;
                const heatingAdj = T_supply_curve - 0.2 * roomError;
                const val = parseFloat(heatingAdj.toFixed(2));
                if (val !== lastSupplyTarget) {
                    messages.push({ topic: supplyTargetTopic, payload: val });
                    lastSupplyTarget = val;
                }
            }

            for (const m of messages) {
                log(`[mpc-house:${node.name}] -> ${JSON.stringify(m)}`);
                send(m);
            }
        }
    }

    RED.nodes.registerType("uniflex-mpc-house", MpcHouseNode);
};
