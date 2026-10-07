const ts = require("../../core/lib/timestamp.js");
// mpc-floor-advanced.js
// Model-based floor valve control: computes valve open duration from thermal energy balance.
// Force open/close: output gate at sendValve level; normal control logic runs unaffected.
//
// Per tick the node solves:
//   E_gap    = Cf x (Tf_set - Tf_ret)                     energy to close floor temp gap
//   E_loss   = Uf x (Tf_ret - Troom) x dt                 floor->room loss during tick
//   E_total  = E_gap + E_loss                              total energy to deliver
//   Q_del    = K_room x (Tsupply - Tf_ret)                 delivery rate when valve open
//   open_sec = E_total / Q_del x 3600                      required open time

module.exports = function (RED) {
    const NODE_VERSION = "0.3.5-charge-hold"; // A planned charge slot is not closed by the room-satisfied cut

    function MpcFloorAdvancedNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";

        // --- Topics ---
        node.setpointTopic = config.setpointTopic || "";
        node.returnTopic = config.returnTopic || "";
        node.valveCmdTopic = config.valveCmdTopic || "";
        node.roomTickTopic = config.roomTickTopic || "";
        node.roomSetpointTopic = config.roomSetpointTopic || "";
        node.roomActualTopic = config.roomActualTopic || "";
        node.supplyTempTopic = (config.supplyTempTopic || "").trim();
        node.coolingModeTopic = config.coolingModeTopic || "heating/mode/cooling";
        node.dewPointTopic = config.dewPointTopic || "";
        node.dewPointFixed = config.dewPointFixed != null && config.dewPointFixed !== "" ? Number(config.dewPointFixed) : null;
        node.forceOpenTopic = (config.forceOpenTopic || "").trim();
        node.supervisorForceOpenTopic = (config.supervisorForceOpenTopic || "").trim();
        node.forceCloseTopic = (config.forceCloseTopic || "").trim();
        node.measurementNotifyTopic = (config.measurementNotifyTopic || "").trim();
        node.verboseLoggingTopic = config.verboseLoggingTopic || "";
        node.verboseLogging = config.verboseLogging === true;
        node._verboseFromMsg = false;

        // --- Thermal model ---
        node.K_room = Number(config.K_room ?? 0.04);
        node.Cf = Number(config.Cf ?? 0.15);
        node.Uf = Number(config.Uf ?? 0.02);
        node.supplyDtFallback = Number(config.supplyDtFallback ?? 10);

        // --- Adaptive K_room ---
        node.enableAdaptiveK = config.enableAdaptiveK === true;
        node.etaK = Number(config.etaK ?? 0.1);
        node.K_room_min = Number(config.K_room_min ?? 0.005);
        node.K_room_max = Number(config.K_room_max ?? 0.5);

        // --- Valve control ---
        node.minOpenSec = Number(config.minOpenSec ?? 180);
        node.maxTicksWithoutOutput = Math.max(0, parseInt(config.maxTicksWithoutOutput, 10) || 2);
        node.valveType = (config.valveType || "NC").toUpperCase() === "NO" ? "NO" : "NC";
        node.dewMarginC = Number(config.dewMarginC ?? 1.0);
        node.roomSatisfiedMarginC = Number(config.roomSatisfiedMarginC ?? 0.3);

        // --- State ---
        let latestSetpoint = null;
        let latestReturn = null;
        let latestSupplyTemp = null;
        let latestRoomActual = null;
        let latestRoomSetpoint = null;
        let coolingMode = false;
        let dewPointC = null;

        let emergencyOnOffMode = false; // Simple on-off when very cold

        let pendingPeriodSec = 0;
        let lastTickTsSec = null;
        let awaitingSetpointAfterTick = false;
        let carryoverSec = 0;
        let ticksWithoutOutput = 0;
        let valveOpen = false;
        let autoValveOpen = false;
        let closeTimer = null;
        let forceOpenRoom = false;
        let forceOpenSupervisor = false;
        let chargeForceOpen = false;
        let forceClose = false;
        let _measurementOpenActive = false;
        let lastSentValvePayload = null;
        let lastCloseReason = "";

        let K_room_live = (() => {
            if (!node.enableAdaptiveK) return node.K_room;
            const v = node.context().get("K_room_adapted");
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(node.K_room_min, Math.min(node.K_room_max, n)) : node.K_room;
        })();

        let adaptTrack = null;
        let adaptStartTimer = null;

        // -- Helpers --

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }
        function verbose(msg) {
            if (node.verboseLogging || node._verboseFromMsg) node.debug(`[mpc-floor-adv:${node.name}] ${msg}`);
        }

        // -- Valve output (with force gate) --

        function getEffectiveOutput() {
            return autoValveOpen ? 1 : 0;
        }
        function getOutputReason() {
            if (forceOpenRoom || forceOpenSupervisor) return "force open (gate)";
            if (forceClose) return "force close (gate)";
            if (chargeForceOpen) return "charge open";
            return autoValveOpen ? "auto open" : "auto close";
        }
        function sendValve(v, measurementNotifyPayload, reason) {
            if (forceOpenRoom || forceOpenSupervisor) v = 1;
            else if (forceClose) v = 0;
            else if (chargeForceOpen) v = 1;
            const doValue = node.valveType === "NO" ? (v ? 0 : 1) : v ? 1 : 0;
            const topic = node.valveCmdTopic || "valve";
            const changed = lastSentValvePayload !== doValue;
            lastSentValvePayload = doValue;
            node.send({ topic, payload: doValue });
            if (changed) {
                const reasonStr = reason != null && reason !== "" ? reason : getOutputReason();
                verbose(`valve output payload=${doValue} topic=${topic} | reason: ${reasonStr}`);
            }
            if (node.measurementNotifyTopic && measurementNotifyPayload !== undefined && measurementNotifyPayload !== null) {
                node.send({ topic: node.measurementNotifyTopic, payload: measurementNotifyPayload });
            }
        }
        function sendEffectiveOutput(reason) {
            if (node.valveCmdTopic) sendValve(getEffectiveOutput(), undefined, reason);
        }
        function openValve(reason, measurementNotifyPayload) {
            if (reason === "tick") autoValveOpen = true;
            if (!valveOpen) valveOpen = true;
            const logReason = reason || "open";
            if (measurementNotifyPayload !== undefined && measurementNotifyPayload !== null) {
                _measurementOpenActive = true;
                sendValve(getEffectiveOutput(), measurementNotifyPayload, logReason);
            } else {
                sendEffectiveOutput(logReason);
            }
            verbose(`valve OPEN${reason ? " (" + reason + ")" : ""}`);
            setStatus(`Valve opened (${ts.formatStatus()})`, "green");
        }
        function closeValve(reason) {
            const r = (typeof reason === "string" ? reason : lastCloseReason) || "--";
            autoValveOpen = false;
            if (valveOpen) {
                valveOpen = false;
                verbose(`valve CLOSE: ${r}`);
                if (_measurementOpenActive && node.measurementNotifyTopic) {
                    sendValve(0, 0, r);
                    _measurementOpenActive = false;
                } else {
                    sendEffectiveOutput(r);
                }
                const fill = r.indexOf("scheduled") !== -1 || r.indexOf("openSec") !== -1 ? "black" : "grey";
                setStatus(`Valve closed (${ts.formatStatus()})`, fill);
            }
            if (adaptStartTimer) {
                clearTimeout(adaptStartTimer);
                adaptStartTimer = null;
            }
            updateAdaptiveK();
            lastCloseReason = "";
        }
        function scheduleClose(sec, closeReason) {
            const remaining = Math.max(0, Math.floor(sec));
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
            }
            if (remaining > 0) {
                const reason = closeReason || `scheduled (${remaining}s expired)`;
                closeTimer = setTimeout(() => {
                    closeTimer = null;
                    lastCloseReason = reason;
                    closeValve();
                }, remaining * 1000);
            }
        }

        // -- Adaptive K_room --

        function captureAdaptStart() {
            if (latestReturn == null) return;
            const delaySec = Math.max(0, node.minOpenSec - 60);
            adaptTrack = {
                Tf_start: Number(latestReturn),
                Tsupply_at_open: latestSupplyTemp != null ? Number(latestSupplyTemp) : null,
                Troom_at_open: latestRoomActual != null ? Number(latestRoomActual) : null,
                openTs: Date.now() / 1000
            };
            verbose(`adapt capture: Tf_start=${adaptTrack.Tf_start.toFixed(2)} (delay=${delaySec}s)`);
        }

        function startAdaptiveTracking(openSec) {
            if (!node.enableAdaptiveK) return;
            if (adaptStartTimer) {
                clearTimeout(adaptStartTimer);
                adaptStartTimer = null;
            }
            const delaySec = Math.max(0, node.minOpenSec - 60);
            if (delaySec > 0 && openSec > delaySec + 30) {
                adaptStartTimer = setTimeout(() => {
                    adaptStartTimer = null;
                    captureAdaptStart();
                }, delaySec * 1000);
            } else {
                captureAdaptStart();
            }
        }

        function updateAdaptiveK() {
            if (!node.enableAdaptiveK || !adaptTrack) {
                adaptTrack = null;
                return;
            }
            const Tf_end = latestReturn != null ? Number(latestReturn) : null;
            const Tsupply_end = latestSupplyTemp != null ? Number(latestSupplyTemp) : null;
            const Troom_end = latestRoomActual != null ? Number(latestRoomActual) : null;
            if (Tf_end == null) {
                adaptTrack = null;
                return;
            }

            const dTf = Tf_end - adaptTrack.Tf_start;
            const dt_h = (Date.now() / 1000 - adaptTrack.openTs) / 3600;
            if (dt_h < 0.01) {
                adaptTrack = null;
                return;
            }

            const Tf_avg = (adaptTrack.Tf_start + Tf_end) / 2;

            const Tsupply_avg =
                adaptTrack.Tsupply_at_open != null && Tsupply_end != null ? (adaptTrack.Tsupply_at_open + Tsupply_end) / 2 : adaptTrack.Tsupply_at_open || Tsupply_end;
            if (Tsupply_avg == null) {
                adaptTrack = null;
                return;
            }
            const dT_supply = Tsupply_avg - Tf_avg;
            if (Math.abs(dT_supply) < 1.5) {
                adaptTrack = null;
                return;
            }

            const Troom_avg = adaptTrack.Troom_at_open != null && Troom_end != null ? (adaptTrack.Troom_at_open + Troom_end) / 2 : adaptTrack.Troom_at_open || Troom_end || Tf_avg;

            const E_actual = node.Cf * dTf + node.Uf * (Tf_avg - Troom_avg) * dt_h;
            const K_measured = E_actual / (dT_supply * dt_h);

            if (Number.isFinite(K_measured) && K_measured > 0) {
                const K_prev = K_room_live;
                K_room_live = K_room_live * (1 - node.etaK) + K_measured * node.etaK;
                K_room_live = Math.max(node.K_room_min, Math.min(node.K_room_max, K_room_live));
                node.context().set("K_room_adapted", K_room_live);
                verbose(
                    `adaptive K: measured=${K_measured.toFixed(4)} prev=${K_prev.toFixed(4)} new=${K_room_live.toFixed(4)} (dTf=${dTf.toFixed(2)} dt=${(dt_h * 60).toFixed(0)}min Tsup_avg=${Tsupply_avg.toFixed(1)})`
                );
            }
            adaptTrack = null;
        }

        // -- Room satisfaction guard (between-tick safety) --

        let roomSatisfiedCutActive = false;

        function isRoomSatisfied() {
            if (coolingMode) return false;
            if (latestRoomActual == null || latestRoomSetpoint == null) return false;
            return Number(latestRoomActual) > Number(latestRoomSetpoint) + node.roomSatisfiedMarginC;
        }

        // Cheap-hour charge: while the current hp_ena slot is on, force open floors whose
        // return (else room actual) is at or below the air setpoint, plus those closest above it.
        function floorChargeActual() {
            if (Number.isFinite(latestReturn)) return Number(latestReturn);
            if (Number.isFinite(latestRoomActual)) return Number(latestRoomActual);
            return null;
        }
        function computeChargeWant() {
            if (coolingMode || forceClose) return false;
            const plan = node.context().global.get("hpChargePlan");
            if (!plan || !Array.isArray(plan.hp_ena) || !plan.stepSec || plan.baseSlot == null) return false;
            if (Date.now() - (plan.timestamp || 0) > 20 * 3600 * 1000) return false;
            const nowSec = Math.floor(Date.now() / 1000);
            const idx = Math.floor((nowSec - plan.baseSlot) / plan.stepSec);
            if (idx < 0 || idx >= plan.hp_ena.length || plan.hp_ena[idx] !== 1) return false;

            const actual = floorChargeActual();
            const airSp = Number(latestRoomSetpoint);
            if (!Number.isFinite(actual) || !Number.isFinite(airSp)) return false;

            const key = node.name || node.id;
            const prev = node.context().global.get("floorChargeState") || {};
            const nowMs = Date.now();
            const fresh = {};
            for (const [k, r] of Object.entries(prev)) {
                if (r && nowMs - r.ts < 600000 && Number.isFinite(r.actual) && Number.isFinite(r.airSp)) fresh[k] = r;
            }
            fresh[key] = { actual: actual, airSp: airSp, ts: nowMs };
            node.context().global.set("floorChargeState", fresh);

            const below = [];
            const above = [];
            for (const [k, r] of Object.entries(fresh)) {
                const d = r.actual - r.airSp;
                if (d <= 0) below.push(k);
                else above.push({ k: k, d: d });
            }
            if (below.indexOf(key) >= 0) return true;
            if (above.length === 0) return false;
            above.sort((a, b) => a.d - b.d);
            const best = above[0].d;
            for (let i = 0; i < above.length; i++) {
                if (above[i].k === key && above[i].d <= best + 0.1) return true;
            }
            return false;
        }
        function applyChargeForce() {
            const want = computeChargeWant();
            if (want === chargeForceOpen) return;
            chargeForceOpen = want;
            const actual = floorChargeActual();
            const airSp = Number(latestRoomSetpoint);
            node.log(
                `[mpc-floor-adv:${node.name}] charge force ${want ? 1 : 0}` +
                    (Number.isFinite(actual) ? ` actual=${actual.toFixed(1)}` : "") +
                    (Number.isFinite(airSp) ? ` airSp=${airSp.toFixed(1)}` : "")
            );
            sendEffectiveOutput(want ? "charge open" : "charge release");
        }

        function checkRoomSatisfied() {
            if (chargeForceOpen) return;
            if (!isRoomSatisfied()) {
                roomSatisfiedCutActive = false;
                return;
            }
            if (roomSatisfiedCutActive && !autoValveOpen) return;
            roomSatisfiedCutActive = true;
            const Ti = Number(latestRoomActual);
            const Tset = Number(latestRoomSetpoint);
            node.warn(`[mpc-floor-adv:${node.name}] ROOM SATISFIED CUT: Ti=${Ti.toFixed(1)} > Tset=${Tset.toFixed(1)}+${node.roomSatisfiedMarginC} -> closing valve`);
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
            }
            autoValveOpen = false;
            valveOpen = false;
            carryoverSec = 0;
            sendEffectiveOutput("room satisfied");
            setStatus(`Room satisfied Ti=${Ti.toFixed(1)} (${ts.formatStatus()})`, "blue");
        }

        // -- Core: model-based duty computation --

        function computeAndAct(periodSec) {
            verbose(
                `computeAndAct(periodSec=${periodSec}) setpoint=${latestSetpoint} return=${latestReturn} supply=${latestSupplyTemp} room=${latestRoomActual} roomSP=${latestRoomSetpoint} forceOpen=${forceOpenRoom || forceOpenSupervisor} forceClose=${forceClose}`
            );

            // Emergency cold-start: if Tf setpoint missing but room is very cold, force valve open
            if (latestSetpoint == null && latestRoomSetpoint != null && latestRoomActual != null) {
                const Ti = Number(latestRoomActual);
                const Tset = Number(latestRoomSetpoint);
                const error = Tset - Ti;

                node.warn(`[mpc-floor-adv:${node.name}] COLD-START CHECK: Ti=${Ti.toFixed(1)} Tset=${Tset.toFixed(1)} error=${error.toFixed(1)}C forceClose=${forceClose}`);

                if (error > 2.0 && !forceClose) {
                    node.warn(
                        `[mpc-floor-adv:${node.name}] COLD-START EMERGENCY: Ti=${Ti.toFixed(1)} Tset=${Tset.toFixed(1)} error=${error.toFixed(1)}C, no Tf setpoint -> force valve open ${node.minOpenSec}s`
                    );
                    autoValveOpen = true;
                    valveOpen = true;
                    carryoverSec = node.minOpenSec; // Use minOpenSec as emergency heating
                    sendEffectiveOutput("emergency cold-start");
                    setStatus(`Emergency heating Ti=${Ti.toFixed(1)} (${ts.formatStatus()})`, "yellow");
                    return;
                }
            }

            if (latestSetpoint == null || latestReturn == null) {
                verbose(`SKIP: waiting inputs`);
                setStatus(`Waiting inputs (${ts.formatStatus()})`, "grey");
                return;
            }

            // Room satisfaction guard. A planned charge slot stays open: the air is
            // already near setpoint on purpose, and closing the valve throws the charge away.
            if (isRoomSatisfied() && !computeChargeWant()) {
                const Ti = Number(latestRoomActual);
                const Tset = Number(latestRoomSetpoint);
                node.warn(`[mpc-floor-adv:${node.name}] ROOM SATISFIED: Ti=${Ti.toFixed(1)} > Tset=${Tset.toFixed(1)}+${node.roomSatisfiedMarginC} -> skip heating`);
                closeValve("room satisfied");
                carryoverSec = 0;
                setStatus(`Room satisfied Ti=${Ti.toFixed(1)} (${ts.formatStatus()})`, "blue");
                return;
            }

            const Tf_set = Number(latestSetpoint);
            const Tf_ret = Number(latestReturn);
            const Troom = latestRoomActual != null ? Number(latestRoomActual) : Tf_ret;
            const Tsupply = latestSupplyTemp != null ? Number(latestSupplyTemp) : null;
            const dt_h = periodSec / 3600;

            // Dew point guard (cooling only)
            const effectiveDew = typeof dewPointC === "number" ? dewPointC : node.dewPointFixed != null && Number.isFinite(node.dewPointFixed) ? node.dewPointFixed : null;
            if (coolingMode && effectiveDew != null) {
                const minSafe = effectiveDew + node.dewMarginC;
                if (Tf_set < minSafe) {
                    closeValve(`dew limit (Tf_set=${Tf_set.toFixed(1)} < ${minSafe.toFixed(1)})`);
                    setStatus(`Dew limited (${ts.formatStatus()})`, "black");
                    return;
                }
            }

            // Energy gap (kWh): energy to move floor from current temp to setpoint
            const floor_error = Tf_set - Tf_ret;
            const E_gap = node.Cf * floor_error;

            // Floor-to-room energy exchange during this tick (kWh)
            // Positive when floor is warmer than room (floor loses heat)
            const E_floor_room = node.Uf * (Tf_ret - Troom) * dt_h;

            // Total energy the valve must deliver this tick
            const E_total = E_gap + E_floor_room;

            // Supply-return dT for delivery rate
            let dT_supply;
            if (Tsupply != null) {
                dT_supply = Tsupply - Tf_ret;
            } else {
                dT_supply = coolingMode ? -node.supplyDtFallback : node.supplyDtFallback;
            }

            // Check if heating or cooling is needed
            const needsHeating = !coolingMode && E_total > 0.001;
            const needsCooling = coolingMode && E_total < -0.001;

            if (!needsHeating && !needsCooling) {
                verbose(`at setpoint (E_total=${(E_total * 1000).toFixed(0)} Wh)`);
                closeValve("at setpoint");
                setStatus(`At setpoint (${ts.formatStatus()})`, "black");
                carryoverSec = 0;
                ticksWithoutOutput = 0;
                return;
            }

            const Q_delivery = K_room_live * dT_supply;
            if (Math.abs(Q_delivery) < 0.001) {
                closeValve("Q_delivery ~ 0");
                carryoverSec = 0;
                return;
            }

            const open_sec_raw = (E_total / Q_delivery) * 3600;
            verbose(
                `model: E_gap=${(E_gap * 1000).toFixed(0)}Wh E_loss=${(E_floor_room * 1000).toFixed(0)}Wh E_total=${(E_total * 1000).toFixed(0)}Wh Q_del=${(Q_delivery * 1000).toFixed(0)}W dT_sup=${dT_supply.toFixed(1)} K=${K_room_live.toFixed(4)} open_raw=${open_sec_raw.toFixed(0)}s`
            );

            if (open_sec_raw <= 0) {
                closeValve("open_sec <= 0");
                carryoverSec = 0;
                return;
            }

            let want = open_sec_raw + carryoverSec;

            // Carryover / minOpen logic
            if (want < node.minOpenSec) {
                ticksWithoutOutput++;
                if (ticksWithoutOutput > node.maxTicksWithoutOutput) {
                    const openSec = Math.min(node.minOpenSec, periodSec);
                    carryoverSec = 0;
                    const prevTicks = ticksWithoutOutput;
                    ticksWithoutOutput = 0;
                    verbose(`gate open: ${openSec}s after ${prevTicks} ticks without output`);
                    startAdaptiveTracking(openSec);
                    openValve("tick", node.measurementNotifyTopic ? 1 : undefined);
                    scheduleClose(openSec, `scheduled (gate ${openSec}s)`);
                    setStatus(`Open ${openSec}s (gate) / ${periodSec}s (${new Date().toLocaleTimeString("en-GB", { hour12: false })})`, "green");
                    node.log(`[mpc-floor-adv:${node.name}] Tf=${Tf_ret.toFixed(1)} SP=${Tf_set.toFixed(1)} gate ${openSec}s`);
                } else {
                    carryoverSec = want;
                    autoValveOpen = false;
                    verbose(`carryover: want=${want.toFixed(0)}s < minOpen=${node.minOpenSec}s (ticks=${ticksWithoutOutput}/${node.maxTicksWithoutOutput})`);
                    setStatus(`Carry ${carryoverSec.toFixed(0)}s (${ts.formatStatus()})`, "black");
                    sendEffectiveOutput("carryover");
                    node.log(`[mpc-floor-adv:${node.name}] Tf=${Tf_ret.toFixed(1)} SP=${Tf_set.toFixed(1)} carry=${Math.floor(carryoverSec)}s E=${(E_total * 1000).toFixed(0)}Wh`);
                }
                return;
            }

            ticksWithoutOutput = 0;
            const openSec = Math.min(want, periodSec);
            carryoverSec = 0;

            verbose(`OPEN ${Math.floor(openSec)}s / ${periodSec}s (carry_after=${Math.floor(carryoverSec)})`);
            startAdaptiveTracking(openSec);
            openValve("tick");
            scheduleClose(openSec, `scheduled (${Math.floor(openSec)}s)`);
            setStatus(`Open ${Math.floor(openSec)}s / ${periodSec}s (${new Date().toLocaleTimeString("en-GB", { hour12: false })})`, "green");
            node.log(
                `[mpc-floor-adv:${node.name}] Tf=${Tf_ret.toFixed(1)} SP=${Tf_set.toFixed(1)} e=${floor_error.toFixed(2)} E=${(E_total * 1000).toFixed(0)}Wh Q=${(Q_delivery * 1000).toFixed(0)}W open=${Math.floor(openSec)}s/${periodSec}s K=${K_room_live.toFixed(4)} carry=${Math.floor(carryoverSec)}`
            );
        }

        // -- Tick handler --

        function handleTick(msg) {
            applyChargeForce();
            const nowSec = Math.floor(Date.now() / 1000);
            if (lastTickTsSec != null) {
                const elapsed = nowSec - lastTickTsSec;
                if (elapsed >= 10 && elapsed <= 7200) pendingPeriodSec = Math.round(elapsed);
            }
            lastTickTsSec = nowSec;
            if (pendingPeriodSec <= 0) pendingPeriodSec = Number(msg.payload?.periodSec || 0) || 300;
            awaitingSetpointAfterTick = true;
            verbose(`tick periodSec=${pendingPeriodSec} -> waiting setpoint`);
            setStatus(`Tick; waiting setpoint (${ts.formatStatus()})`, "blue");
            sendEffectiveOutput("sync (tick)");
        }

        // -- Input handler --

        node.on("input", (msg) => {
            const t = msg.topic || "";

            if (t === node.roomTickTopic) {
                handleTick(msg);
                return;
            }

            if (t === node.setpointTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) latestSetpoint = v;
                if (awaitingSetpointAfterTick && pendingPeriodSec) {
                    verbose(`setpoint ${v} after tick -> computeAndAct(${pendingPeriodSec})`);
                    awaitingSetpointAfterTick = false;
                    computeAndAct(pendingPeriodSec);
                    pendingPeriodSec = 0;
                }
                return;
            }
            if (t === node.returnTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) latestReturn = v;
                applyChargeForce();
                return;
            }
            if (t === node.supplyTempTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) latestSupplyTemp = v;
                return;
            }
            if (t === node.roomActualTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) {
                    latestRoomActual = v;
                    applyChargeForce();
                    checkRoomSatisfied();

                    // EMERGENCY HEATING ONLY: Force valve open when room too cold and valve is closed
                    // Enter: error > 2.5C AND valve would be closed by normal MPC
                    // Exit: error < 2.0C AND normal MPC also wants valve open
                    if (latestRoomSetpoint != null && !forceClose && !coolingMode) {
                        const error = latestRoomSetpoint - v; // positive = too cold

                        // Enter emergency mode: room too cold (> 2.5C) and valve currently closed
                        if (error > 2.5 && !emergencyOnOffMode && !valveOpen) {
                            emergencyOnOffMode = true;
                            autoValveOpen = true;
                            valveOpen = true;

                            node.warn(`[mpc-floor-adv:${node.name}] EMERGENCY HEAT: Ti=${v.toFixed(1)} error=${error.toFixed(1)}C, valve was closed -> forcing OPEN`);
                            sendEffectiveOutput(`emergency heat`);
                            setStatus(`EMERGENCY HEAT Ti=${v.toFixed(1)} err=${error.toFixed(1)}C (${ts.formatStatus()})`, "red");
                            return;
                        }

                        // Stay in emergency mode and update status
                        if (emergencyOnOffMode) {
                            // Exit emergency: error improved to < 2.0C
                            if (error < 2.0) {
                                emergencyOnOffMode = false;
                                autoValveOpen = false;
                                valveOpen = false;
                                node.warn(`[mpc-floor-adv:${node.name}] EMERGENCY OFF: Ti=${v.toFixed(1)} error=${error.toFixed(1)}C improved -> resume normal control`);
                                sendEffectiveOutput("emergency off");
                                return;
                            }

                            // Still in emergency - keep valve open if error still high
                            if (error > 0) {
                                autoValveOpen = true;
                                valveOpen = true;
                                sendEffectiveOutput(`emergency heat`);
                                setStatus(`EMERGENCY HEAT Ti=${v.toFixed(1)} err=${error.toFixed(1)}C (${ts.formatStatus()})`, "red");
                            } else {
                                // Error went negative (room now too warm) - close valve but stay in emergency mode
                                autoValveOpen = false;
                                valveOpen = false;
                                sendEffectiveOutput(`emergency wait`);
                                setStatus(`Emergency: waiting, Ti=${v.toFixed(1)} err=${error.toFixed(1)}C (${ts.formatStatus()})`, "yellow");
                            }
                            return; // Skip normal MPC logic while in emergency
                        }
                    }
                }
                return;
            }
            if (t === node.roomSetpointTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) {
                    latestRoomSetpoint = v;
                    applyChargeForce();
                    checkRoomSatisfied();
                }
                return;
            }
            if (t === node.coolingModeTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                coolingMode = !!bit;
                return;
            }
            if (t === node.dewPointTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) dewPointC = v;
                return;
            }

            // Force open/close -- just set flag + gate output
            if (t === node.forceOpenTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                const v = !!bit;
                if (forceOpenRoom === v) return;
                forceOpenRoom = v;
                node.log(`[mpc-floor-adv:${node.name}] force open (room) ${v ? 1 : 0}`);
                sendEffectiveOutput(`force open (room) ${v ? 1 : 0}`);
                if (forceOpenRoom || forceOpenSupervisor) setStatus("Forced open", "yellow");
                else if (forceClose) setStatus("Forced closed", "red");
                else setStatus(autoValveOpen ? "Valve opened" : "Valve closed", autoValveOpen ? "green" : "black");
                return;
            }
            if (t === node.supervisorForceOpenTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                const v = !!bit;
                if (forceOpenSupervisor === v) return;
                forceOpenSupervisor = v;
                node.log(`[mpc-floor-adv:${node.name}] force open (supervisor) ${v ? 1 : 0}`);
                sendEffectiveOutput(`force open (supervisor) ${v ? 1 : 0}`);
                if (forceOpenRoom || forceOpenSupervisor) setStatus("Forced open", "yellow");
                else if (forceClose) setStatus("Forced closed", "red");
                else setStatus(autoValveOpen ? "Valve opened" : "Valve closed", autoValveOpen ? "green" : "black");
                return;
            }
            if (t === node.forceCloseTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                const v = !!bit;
                if (forceClose === v) return;
                forceClose = v;
                node.log(`[mpc-floor-adv:${node.name}] force close ${v ? 1 : 0}`);
                sendEffectiveOutput(`force close ${v ? 1 : 0}`);
                if (forceClose) setStatus("Forced closed", "red");
                else if (forceOpenRoom || forceOpenSupervisor) setStatus("Forced open", "yellow");
                else setStatus(autoValveOpen ? "Valve opened" : "Valve closed", autoValveOpen ? "green" : "black");
                return;
            }
            if (node.verboseLoggingTopic && t === node.verboseLoggingTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                node._verboseFromMsg = !!bit;
                verbose(`verbose ${node._verboseFromMsg ? "ON" : "OFF"}`);
                return;
            }
        });

        node.on("close", () => {
            if (closeTimer) clearTimeout(closeTimer);
            if (adaptStartTimer) clearTimeout(adaptStartTimer);
            node.status({});
        });

        node.log(
            `[mpc-floor-adv:${node.name}] *** ${NODE_VERSION} *** Model-based. K_room=${K_room_live.toFixed(4)} Cf=${node.Cf} Uf=${node.Uf} adaptive=${node.enableAdaptiveK} supply=${node.supplyTempTopic || "(none)"} tick=${node.roomTickTopic}`
        );
        setStatus(`Ready - tick: ${node.roomTickTopic || "n/a"}`, "grey");
    }

    RED.nodes.registerType("uniflex-mpc-floor-advanced", MpcFloorAdvancedNode);
};
