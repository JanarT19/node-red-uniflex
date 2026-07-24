const ts = require("../../core/lib/timestamp.js");
// mpc-floor.js
// Floor valve control: P + optional feedforward, and model-based predictive close.
// Rough floor model (docs/brainstorms/heating/mpc.md §3.0.2): 40 mm concrete, T_surface follows T_return
// with τ_pipe_surface ≈ 1 h. We estimate T_surface and limit open time so
// predicted surface reaches setpoint without overshoot.

module.exports = function (RED) {
    const NODE_VERSION = "0.1.0-draft";

    function MpcFloorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.minOpenSec = Number(config.minOpenSec ?? 180);
        node.maxTicksWithoutOutput = Math.max(0, parseInt(config.maxTicksWithoutOutput, 10) || 2);
        node.dewMarginC = Number(config.dewMarginC ?? 1.0);

        node.setpointTopic = config.setpointTopic || "";
        node.returnTopic = config.returnTopic || "";
        node.valveCmdTopic = config.valveCmdTopic || "";
        node.roomTickTopic = config.roomTickTopic || "";
        node.roomErrorTopic = config.roomErrorTopic || "";
        node.roomSetpointTopic = config.roomSetpointTopic || "";
        node.roomActualTopic = config.roomActualTopic || "";
        node.coolingModeTopic = config.coolingModeTopic || "heating/mode/cooling";
        node.dewPointTopic = config.dewPointTopic || "";
        node.dewPointFixed = config.dewPointFixed != null && config.dewPointFixed !== "" ? Number(config.dewPointFixed) : null;
        node.forceOpenTopic = (config.forceOpenTopic || "").trim();
        node.supervisorForceOpenTopic = (config.supervisorForceOpenTopic || "").trim();
        node.forceCloseTopic = (config.forceCloseTopic || "").trim();
        node.measurementNotifyTopic = (config.measurementNotifyTopic || "").trim();

        node.Kp = Number(config.Kp ?? 0.3);
        node.Kff = Number(config.Kff ?? 0.0);
        node.enableAdaptiveKff = config.enableAdaptiveKff === true;
        node.etaKff = Number(config.etaKff ?? 0.02);
        node.KffMin = Number(config.KffMin ?? 0);
        node.KffMax = Number(config.KffMax ?? 0.5);
        node.Ki_room = Number(config.Ki_room ?? 0);
        node.deadbandC = Number(config.deadbandC ?? 0.0);
        node.closeMarginC = Number(config.closeMarginC ?? 0.5);
        node.tauPipeSurfaceSec = Number(config.tauPipeSurfaceSec ?? 3600);
        node.useModelBasedClose = config.useModelBasedClose !== false;
        node.valveType = (config.valveType || "NC").toUpperCase() === "NO" ? "NO" : "NC";
        node.verboseLogging = config.verboseLogging === true;
        node.verboseLoggingTopic = config.verboseLoggingTopic || "";
        node._verboseFromMsg = false;

        let latestSetpoint = null;
        let latestReturn = null;
        let T_surface_est = null;
        let lastUpdateTs = null;
        let coolingMode = false;
        let dewPointC = null;
        let roomErrorC = 0;
        let latestRoomSetpoint = null;
        let latestRoomActual = null;

        let pendingPeriodSec = 0;
        let lastTickTsSec = null;
        let awaitingSetpointAfterTick = false;
        let carryoverSec = 0;
        let ticksWithoutOutput = 0;
        let valveOpen = false;
        let autoValveOpen = false;
        let closeTimer = null;
        let openStartedAt = null;
        let forceOpenRoom = false;
        let forceOpenSupervisor = false;
        let forceClose = false;
        let _measurementOpenActive = false;
        let lastSentValvePayload = null;
        let I_room = (() => {
            if (node.Ki_room <= 0) return 0;
            const v = node.context().get("I_room");
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
        })();
        let Kff_adapted = (() => {
            if (!node.enableAdaptiveKff) return node.Kff;
            const v = node.context().get("Kff_adapted");
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(node.KffMin, Math.min(node.KffMax, n)) : node.Kff;
        })();

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }
        function verbose(msg) {
            if (node.verboseLogging || node._verboseFromMsg) node.debug(`[mpc-floor:${node.name}] ${msg}`);
        }

        let lastCloseReason = "";

        function getEffectiveOutput() {
            return autoValveOpen ? 1 : 0;
        }
        function getOutputReason() {
            if (forceOpenRoom || forceOpenSupervisor) return "force open (gate)";
            if (forceClose) return "force close (gate)";
            return autoValveOpen ? "auto open" : "auto close";
        }
        function sendValve(v, measurementNotifyPayload, reason) {
            if (forceOpenRoom || forceOpenSupervisor) v = 1;
            else if (forceClose) v = 0;
            const doValue = node.valveType === "NO" ? (v ? 0 : 1) : v ? 1 : 0;
            const topic = node.valveCmdTopic || "valve";
            const changed = lastSentValvePayload !== doValue;
            lastSentValvePayload = doValue;
            const valveMsg = { topic: topic, payload: doValue };
            node.send(valveMsg);
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
            const fill = reason && reason.indexOf("force") !== -1 ? "yellow" : "green";
            setStatus(`Valve opened (${ts.formatStatus()})`, fill);
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
                const fill = r.indexOf("scheduled") !== -1 || r.indexOf("openSec") !== -1 || r.indexOf("dew") !== -1 || r.indexOf("model") !== -1 ? "black" : "grey";
                setStatus(`Valve closed (${ts.formatStatus()})`, fill);
            }
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

        function updateSurfaceEstimate(T_return, nowSec) {
            const τ = node.tauPipeSurfaceSec;
            if (τ <= 0 || !Number.isFinite(T_return)) return;
            if (T_surface_est == null || lastUpdateTs == null) {
                T_surface_est = T_return;
                lastUpdateTs = nowSec;
                return;
            }
            let dt = nowSec - lastUpdateTs;
            if (dt <= 0) return;
            if (dt > 86400) dt = 86400;
            T_surface_est = T_return + (T_surface_est - T_return) * Math.exp(-dt / τ);
            lastUpdateTs = nowSec;
        }

        function computeAndAct(periodSec) {
            verbose(
                `computeAndAct(periodSec=${periodSec}) latestSetpoint=${latestSetpoint} latestReturn=${latestReturn} forceOpen=${forceOpenRoom || forceOpenSupervisor} forceClose=${forceClose}`
            );

            if (latestSetpoint == null || latestReturn == null) {
                verbose(`SKIP: waiting inputs (setpoint=${latestSetpoint} return=${latestReturn})`);
                setStatus(`Waiting inputs (${ts.formatStatus()})`, "grey");
                return;
            }

            const T_set = Number(latestSetpoint);
            const T_ret = Number(latestReturn);
            const nowSec = Math.floor(Date.now() / 1000);
            updateSurfaceEstimate(T_ret, nowSec);
            const e_floor = T_set - T_ret;
            verbose(
                `inputs T_set=${T_set.toFixed(1)} T_ret=${T_ret.toFixed(1)} e_floor=${e_floor.toFixed(2)} T_surface_est=${T_surface_est != null ? T_surface_est.toFixed(2) : "null"} coolingMode=${coolingMode}`
            );

            const effectiveDew = typeof dewPointC === "number" ? dewPointC : node.dewPointFixed != null && Number.isFinite(node.dewPointFixed) ? node.dewPointFixed : null;
            if (coolingMode && effectiveDew != null) {
                const minSafe = effectiveDew + node.dewMarginC;
                if (T_set < minSafe) {
                    verbose(`SKIP: cooling dew limit T_set=${T_set.toFixed(1)} < minSafe=${minSafe.toFixed(1)}`);
                    closeValve(`cooling dew limit (T_set=${T_set.toFixed(1)} < minSafe=${minSafe.toFixed(1)})`);
                    setStatus(`Cooling limited (dew ${effectiveDew.toFixed(1)} + ${node.dewMarginC}°C) (${ts.formatStatus()})`, "black");
                    node.warn(`[mpc-floor:${node.name}] Tret=${T_ret} SP=${T_set} e=${e_floor.toFixed(2)} (dew-limit)`);
                    return;
                }
            }

            const deadband = node.deadbandC;
            let e_eff = e_floor;
            if (deadband > 0) {
                if (e_floor > deadband) e_eff = e_floor - deadband;
                else if (e_floor < -deadband) e_eff = e_floor + deadband;
                else e_eff = 0;
            }

            const roomErr =
                latestRoomSetpoint != null && latestRoomActual != null ? Number(latestRoomSetpoint) - Number(latestRoomActual) : typeof roomErrorC === "number" ? roomErrorC : 0;
            const forceActive = forceOpenRoom || forceOpenSupervisor || forceClose;
            if (node.Ki_room > 0 && Number.isFinite(roomErr) && !forceActive) {
                const dtHours = periodSec / 3600;
                I_room += node.Ki_room * roomErr * dtHours;
                I_room = Math.max(-1, Math.min(1, I_room));
                node.context().set("I_room", I_room);
            }
            if (node.enableAdaptiveKff && Number.isFinite(roomErr) && !forceActive) {
                const dtHours = periodSec / 3600;
                Kff_adapted += node.etaKff * roomErr * dtHours;
                Kff_adapted = Math.max(node.KffMin, Math.min(node.KffMax, Kff_adapted));
                node.context().set("Kff_adapted", Kff_adapted);
            }
            const Kff_use = node.enableAdaptiveKff ? Kff_adapted : node.Kff;
            const P = node.Kp * e_eff;
            const ff = Kff_use * roomErr;
            let u = P + ff + (node.Ki_room > 0 ? I_room : 0);
            if (coolingMode) u = -u;
            u = Math.max(0, Math.min(1, u));

            const requestedOpenSec = Math.max(0, u * Number(periodSec));
            let want = requestedOpenSec + carryoverSec;
            verbose(
                `duty P=${P.toFixed(3)} ff=${ff.toFixed(3)} Kff=${Kff_use.toFixed(3)} I_room=${(node.Ki_room > 0 ? I_room : 0).toFixed(3)} u=${u.toFixed(3)} requestedOpenSec=${requestedOpenSec.toFixed(0)} carryoverSec=${carryoverSec.toFixed(0)} want=${want.toFixed(0)}`
            );

            if (node.useModelBasedClose && !coolingMode && node.tauPipeSurfaceSec > 0 && T_surface_est != null) {
                const margin = node.closeMarginC;
                const T_target = T_set - margin;
                if (T_ret > T_target && T_surface_est < T_target) {
                    const num = T_surface_est - T_ret;
                    const den = T_target - T_ret;
                    if (den < 0 && num < 0) {
                        const predictiveOpenSec = node.tauPipeSurfaceSec * Math.log(num / den);
                        if (Number.isFinite(predictiveOpenSec) && predictiveOpenSec > 0) {
                            want = Math.min(want, Math.min(predictiveOpenSec, periodSec));
                            verbose(`model-based cap T_target=${T_target.toFixed(1)} predictiveOpenSec=${predictiveOpenSec.toFixed(0)} want_after=${want.toFixed(0)}`);
                        }
                    }
                } else if (T_surface_est >= T_target) {
                    want = 0;
                    verbose(`model-based: T_surface_est=${T_surface_est.toFixed(1)} >= T_target=${T_target.toFixed(1)} => want=0 (no open)`);
                } else {
                    verbose(`model-based: no cap (T_ret=${T_ret.toFixed(1)} > T_target? ${T_ret > T_target} T_surf_est < T_target? ${T_surface_est < T_target})`);
                }
            }

            if (want < node.minOpenSec) {
                ticksWithoutOutput += 1;
                if (ticksWithoutOutput > node.maxTicksWithoutOutput) {
                    const openSec = Math.min(node.minOpenSec, periodSec);
                    carryoverSec = 0;
                    const prevTicks = ticksWithoutOutput;
                    ticksWithoutOutput = 0;
                    autoValveOpen = false;
                    verbose(`FORCE OPEN: ${Math.floor(openSec)}s (min) after ${prevTicks} ticks without output => gate for averager`);
                    openValve("tick", node.measurementNotifyTopic ? 1 : undefined);
                    scheduleClose(openSec, `scheduled (minOpen for gate, ${Math.floor(openSec)}s expired)`);
                    setStatus(`Open ${Math.floor(openSec)}s (min, gate) / ${periodSec}s (${new Date().toLocaleTimeString("en-GB", { hour12: false })})`, "green");
                    node.log(`[mpc-floor:${node.name}] Tret=${T_ret} SP=${T_set} force minOpen=${Math.floor(openSec)}s for gate (was carry=${want.toFixed(0)})`);
                } else {
                    carryoverSec = want;
                    autoValveOpen = false;
                    verbose(
                        `SKIP: want=${want.toFixed(0)} < minOpenSec=${node.minOpenSec} => carryover only (ticksWithoutOutput=${ticksWithoutOutput}/${node.maxTicksWithoutOutput})`
                    );
                    setStatus(`Carryover ${carryoverSec.toFixed(0)}s (${ts.formatStatus()})`, "black");
                    sendEffectiveOutput("sync (carryover)");
                    node.log(
                        `[mpc-floor:${node.name}] Tret=${T_ret} SP=${T_set} e=${e_floor.toFixed(2)} duty=${u.toFixed(2)} period=${periodSec}s want=${want.toFixed(0)}s carry=${Math.floor(carryoverSec)}`
                    );
                }
                return;
            }

            ticksWithoutOutput = 0;
            const openSec = Math.min(want, periodSec);
            carryoverSec = Math.max(0, want - openSec);

            if (openSec <= 0) {
                verbose(`SKIP: openSec=${openSec} <= 0 => close valve`);
                closeValve(`openSec<=0 (model T_surf≥target or cap)`);
                setStatus(`Closed (T_surf≥target) (${ts.formatStatus()})`, "black");
                return;
            }

            verbose(`OPEN valve ${Math.floor(openSec)}s / ${periodSec}s (want=${want.toFixed(0)} carryover_after=${(want - openSec).toFixed(0)})`);
            openValve("tick");
            scheduleClose(openSec, `scheduled (openSec=${Math.floor(openSec)}s expired)`);
            setStatus(`Open ${Math.floor(openSec)}s / ${periodSec}s (${new Date().toLocaleTimeString("en-GB", { hour12: false })})`, "green");
            node.log(
                `[mpc-floor:${node.name}] Tret=${T_ret} SP=${T_set} e=${e_floor.toFixed(2)} duty=${u.toFixed(2)} period=${periodSec}s open=${Math.floor(openSec)}s carry=${Math.floor(carryoverSec)}`
            );
        }

        function handleTick(msg) {
            const nowSec = Math.floor(Date.now() / 1000);
            if (lastTickTsSec != null) {
                const elapsed = nowSec - lastTickTsSec;
                if (elapsed >= 10 && elapsed <= 7200) pendingPeriodSec = Math.round(elapsed);
            }
            lastTickTsSec = nowSec;
            if (pendingPeriodSec <= 0) pendingPeriodSec = Number(msg.payload?.periodSec || 0) || 300;
            awaitingSetpointAfterTick = true;
            verbose(`tick received periodSec=${pendingPeriodSec} (from elapsed or payload.periodSec=${msg.payload?.periodSec}) → waiting for setpoint on "${node.setpointTopic}"`);
            setStatus(`Tick; waiting setpoint (${ts.formatStatus()})`, "blue");
            sendEffectiveOutput("sync (tick)");
        }

        node.on("input", (msg) => {
            const t = msg.topic || "";

            if (t === node.roomTickTopic) {
                handleTick(msg);
                return;
            }
            if (t === node.setpointTopic) {
                const v = Number(msg.payload);
                if (Number.isFinite(v)) latestSetpoint = v;
                if (awaitingSetpointAfterTick && pendingPeriodSec) {
                    verbose(`setpoint received (${v}) after tick → calling computeAndAct(${pendingPeriodSec})`);
                    awaitingSetpointAfterTick = false;
                    computeAndAct(pendingPeriodSec);
                    pendingPeriodSec = 0;
                }
                return;
            }
            if (t === node.returnTopic) {
                const v = Number(msg.payload);
                if (Number.isFinite(v)) {
                    latestReturn = v;
                    updateSurfaceEstimate(v, Math.floor(Date.now() / 1000));
                }
                return;
            }
            if (t === node.roomErrorTopic) {
                const v = Number(msg.payload);
                if (Number.isFinite(v)) roomErrorC = v;
                return;
            }
            if (t === node.roomSetpointTopic) {
                const v = Number(msg.payload);
                if (Number.isFinite(v)) latestRoomSetpoint = v;
                return;
            }
            if (t === node.roomActualTopic) {
                const v = Number(msg.payload);
                if (Number.isFinite(v)) latestRoomActual = v;
                return;
            }
            if (t === node.coolingModeTopic) {
                coolingMode = !!Number(msg.payload);
                return;
            }
            if (t === node.dewPointTopic) {
                const v = Number(msg.payload);
                if (Number.isFinite(v)) dewPointC = v;
                return;
            }
            if (t === node.forceOpenTopic) {
                const v = !!Number(msg.payload);
                if (forceOpenRoom === v) return;
                forceOpenRoom = v;
                node.log(`[mpc-floor:${node.name}] force open (room) ${v ? 1 : 0} (topic=${t})`);
                sendEffectiveOutput(`force open (room) ${v ? 1 : 0}`);
                if (forceOpenRoom || forceOpenSupervisor) setStatus("Forced open", "yellow");
                else if (forceClose) setStatus("Forced closed", "red");
                else setStatus(autoValveOpen ? "Valve opened" : "Valve closed", autoValveOpen ? "green" : "black");
                return;
            }
            if (t === node.supervisorForceOpenTopic) {
                const v = !!Number(msg.payload);
                if (forceOpenSupervisor === v) return;
                forceOpenSupervisor = v;
                node.log(`[mpc-floor:${node.name}] force open (supervisor) ${v ? 1 : 0} (topic=${t})`);
                sendEffectiveOutput(`force open (supervisor) ${v ? 1 : 0}`);
                if (forceOpenRoom || forceOpenSupervisor) setStatus("Forced open", "yellow");
                else if (forceClose) setStatus("Forced closed", "red");
                else setStatus(autoValveOpen ? "Valve opened" : "Valve closed", autoValveOpen ? "green" : "black");
                return;
            }
            if (t === node.forceCloseTopic) {
                const v = !!Number(msg.payload);
                if (forceClose === v) return;
                forceClose = v;
                node.log(`[mpc-floor:${node.name}] force close ${v ? 1 : 0} (topic=${t})`);
                sendEffectiveOutput(`force close ${v ? 1 : 0}`);
                if (forceClose) setStatus("Forced closed", "red");
                else if (forceOpenRoom || forceOpenSupervisor) setStatus("Forced open", "yellow");
                else setStatus(autoValveOpen ? "Valve opened" : "Valve closed", autoValveOpen ? "green" : "black");
                return;
            }
            if (node.verboseLoggingTopic && t === node.verboseLoggingTopic) {
                node._verboseFromMsg = !!Number(msg.payload);
                verbose(`verbose logging ${node._verboseFromMsg ? "ON" : "OFF"} (from topic)`);
                return;
            }
        });

        node.on("close", () => {
            if (closeTimer) clearTimeout(closeTimer);
            node.status({});
        });

        node.log(
            `[mpc-floor:${node.name}] *** ${NODE_VERSION} *** P+FF, model-based close τ=${node.tauPipeSurfaceSec}s. Setpoint=${node.setpointTopic} Return=${node.returnTopic} Tick=${node.roomTickTopic}`
        );
        setStatus(`Ready - tick: ${node.roomTickTopic || "n/a"}`, "grey");
    }

    RED.nodes.registerType("uniflex-mpc-floor", MpcFloorNode);
};
