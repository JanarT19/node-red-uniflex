const ts = require("../../core/lib/timestamp.js");
// floor-loop.js
// Node-RED node: floor-loop
// Purpose: control a discrete floor valve (0/1) using an internal PI and PWM period ticks.
// Notes:
//  - DO command is 0/1 (NO/NC selectable). Open time per period is handled internally.
//  - Persistence saved to /home/nodered/heating_state by default.
//  - Added logs: compute + "PI state saved after compute" (to mirror room-loop).
//  - Weather feedforward: anticipates heating demand changes using iolayer forecast data.

module.exports = function (RED) {
    function FloorLoopNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.minOpenSec = Number(config.minOpenSec ?? 90);
        node.dewMarginC = Number(config.dewMarginC ?? 1.0);

        // Topics
        node.setpointTopic = config.setpointTopic || "";
        node.returnTopic = config.returnTopic || "";
        node.valveCmdTopic = config.valveCmdTopic || "";
        node.roomTickTopic = config.roomTickTopic || "";
        node.roomErrorTopic = config.roomErrorTopic || "";
        node.coolingModeTopic = config.coolingModeTopic || "heating/mode/cooling";
        node.dewPointTopic = config.dewPointTopic || "";
        node.forceOpenTopic = config.forceOpenTopic || "";
        node.forceCloseTopic = config.forceCloseTopic || "";

        // Embedded PI parameters
        node.Kp = Number(config.Kp ?? 1.0);
        node.Ii = Number(config.Ii ?? 0.0); // if provided, Ii overrides Ki
        node.Ki = Number(config.Ki ?? 0.0);

        // Valve type: NC (default) or NO
        node.valveType = (config.valveType || "NC").toUpperCase() === "NO" ? "NO" : "NC";

        // Persistence
        node.persistencePath = config.persistencePath || "/home/nodered/heating_state";

        // Feedforward configuration - from shared thermal model or local settings
        // Priority: thermalModel > legacy heatingConfig (deprecated) > local fields
        let sharedConfig = config.thermalModel ? RED.nodes.getNode(config.thermalModel) : null;
        if (!sharedConfig && config.heatingConfig) {
            sharedConfig = RED.nodes.getNode(config.heatingConfig);
            if (sharedConfig) {
                node.warn(`[floor-loop:${node.name}] heatingConfig is deprecated; link thermalModel instead`);
            }
        }
        if (sharedConfig) {
            node.ffEnable = sharedConfig.ffEnable;
            node.ffHorizon1 = sharedConfig.ffHorizon1;
            node.ffHorizon2 = sharedConfig.ffHorizon2;
            node.ffGainTout = sharedConfig.ffGainTout;
            node.ffGainWind = sharedConfig.ffGainWind;
            node.ffTbalance = Number(sharedConfig.ffTbalance ?? sharedConfig.Tbalance ?? 15);
            node.ffToutTopicPrefix = sharedConfig.ffToutTopicPrefix || "FCTW";
            node.ffWindTopicPrefix = sharedConfig.ffWindTopicPrefix || "FCWW";
            node.debug(`[floor-loop:${node.name}] Using shared thermal model: ${sharedConfig.name}`);
        } else {
            // Fallback to local settings (backward compatible)
            node.ffEnable = !!config.ffEnable;
            node.ffHorizon1 = Number(config.ffHorizon1 ?? 6);
            node.ffHorizon2 = Number(config.ffHorizon2 ?? 12);
            node.ffGainTout = Number(config.ffGainTout ?? 0.25);
            node.ffGainWind = Number(config.ffGainWind ?? 0.02);
            node.ffTbalance = Number(config.ffTbalance ?? 15);
            node.ffToutTopicPrefix = config.ffToutTopicPrefix || "FCTW";
            node.ffWindTopicPrefix = config.ffWindTopicPrefix || "FCWW";
        }

        // ---- STATE
        let latestSetpoint = null; // °C
        let latestReturn = null; // °C
        let coolingMode = false; // boolean
        let dewPointC = null; // °C (optional)
        let roomErrorC = null; // °C (optional)

        let lastTickTs = 0; // seconds
        let pendingPeriodSec = 0; // seconds from clock-ticker
        let awaitingSetpointAfterTick = false;

        let carryoverSec = 0; // seconds carried to next period when below minOpenSec
        let valveOpen = false;
        let closeTimer = null;

        // Feedforward state
        let ffAdjustment = 0; // last computed feedforward adjustment

        // Iolayer forecast cache (updated from incoming messages)
        // Keys are member numbers: 1=3h, 2=6h, 3=12h, 4=24h
        const ffIolayerCache = {
            temp: {}, // { "1": value, "2": value, "3": value, "4": value }
            wind: {} // { "1": value, "2": value, "3": value, "4": value }
        };

        // Map hours to iolayer member numbers
        const HOURS_TO_MEMBER = { 3: "1", 6: "2", 12: "3", 24: "4" };

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        // ---- Feedforward calculation
        // Uses iolayer cached values from forecast-publisher
        function computeFeedforward() {
            if (!node.ffEnable) return 0;

            // Map horizon config (6, 12) to iolayer member numbers (2, 3)
            const h1Key = HOURS_TO_MEMBER[node.ffHorizon1] || "2"; // default 6h = member 2
            const h2Key = HOURS_TO_MEMBER[node.ffHorizon2] || "3"; // default 12h = member 3

            const Tout_h1 = ffIolayerCache.temp[h1Key];
            const Tout_h2 = ffIolayerCache.temp[h2Key];
            const Wind_h1 = ffIolayerCache.wind[h1Key];
            // For "now" value, use member 1 (3h) as proxy (closest available)
            const Tout_now = ffIolayerCache.temp["1"];
            const Wind_now = ffIolayerCache.wind["1"];

            if (Tout_now == null || Tout_h1 == null || Tout_h2 == null) {
                node.debug(`[floor-loop:${node.name}] FF: waiting for iolayer data (have: ${Object.keys(ffIolayerCache.temp).join(",")})`);
                return ffAdjustment; // use last known value
            }

            // Temperature changes (positive = warming, negative = cooling)
            const dTout_h1 = Tout_h1 - Tout_now;
            const dTout_h2 = Tout_h2 - Tout_now;

            // Trend confidence: same direction = 1.0, reversal = 0.5
            const trendConfidence = dTout_h1 * dTout_h2 >= 0 ? 1.0 : 0.5;

            // Wind change
            let dWind_h1 = 0;
            if (node.ffGainWind > 0 && Wind_now != null && Wind_h1 != null) {
                dWind_h1 = Wind_h1 - Wind_now;
            }

            // Feedforward formula:
            // - Outdoor cooling (dTout < 0) → increase setpoint (anticipate higher demand)
            // - Wind increase (dWind > 0) → increase setpoint (more heat loss)
            // - Scale by trend confidence
            const ffTout = -node.ffGainTout * dTout_h1 * trendConfidence;
            const ffWind = node.ffGainWind * Math.max(0, dWind_h1) * trendConfidence;
            const adjustment = ffTout + ffWind;

            // Clamp to reasonable range (-2 to +2 °C)
            ffAdjustment = Math.max(-2, Math.min(2, adjustment));

            node.debug(
                `[floor-loop:${node.name}] FF: Tout=${Tout_now.toFixed(1)}→${Tout_h1.toFixed(1)}(${node.ffHorizon1}h)→${Tout_h2.toFixed(1)}(${node.ffHorizon2}h) ` +
                    `dT=${dTout_h1.toFixed(1)} conf=${trendConfidence} dW=${dWind_h1.toFixed(1)} adj=${ffAdjustment.toFixed(2)}°C`
            );

            return ffAdjustment;
        }

        // ---- Eager PI init
        (function initPI() {
            try {
                const { createPI } = require("./pi-core");
                const pi = createPI({ Kp: node.Kp, Ii: node.Ii, Ki: node.Ki, invert: false, outClampLow: 0, outClampHigh: 1 });
                if (!pi || typeof pi.step !== "function") {
                    node.debug(`createPI() did not return a full API at ${require("path").join(__dirname, "pi-core.js")}`);
                    node._pi = null;
                    return;
                }
                node._pi = pi;
                if (typeof node._pi.setPersistenceFile === "function") {
                    const _pfx = "floor-loop";
                    const _safe = (node.name || "unnamed").replace(/\s+/g, "-");
                    const _stem = _safe === _pfx || _safe.startsWith(_pfx + "-") ? _safe : `${_pfx}-${_safe}`;
                    node._pi.setPersistenceFile(`${node.persistencePath}/${_stem}.json`);
                }
                if (typeof node._pi.setPersistenceMode === "function") node._pi.setPersistenceMode("every"); // save (throttled) every step
                if (typeof node._pi.loadState === "function") {
                    const ok = node._pi.loadState();
                    node.log(`[floor-loop:${node.name}] PI ready. ${ok ? `preloaded I=${node._pi.getIntegral().toFixed(4)}` : "no preload"}`);
                }
                setStatus(`Ready - listening to: ${node.roomTickTopic || "n/a"}`, "grey");
            } catch (e) {
                node.log(`PI init failed: ${e.message}`);
            }
        })();

        // ---- DO helpers
        function sendValve(v) {
            if (!node.valveCmdTopic) return;
            const doValue = node.valveType === "NO" ? (v ? 0 : 1) : v ? 1 : 0;
            node.send({ topic: node.valveCmdTopic, payload: doValue });
        }
        function publishCurrentValveState() {
            if (!node.valveCmdTopic) return;
            const doValue = node.valveType === "NO" ? (valveOpen ? 0 : 1) : valveOpen ? 1 : 0;
            node.send({ topic: node.valveCmdTopic, payload: doValue });
        }
        function openValve() {
            if (!valveOpen) {
                valveOpen = true;
                if (!forceClose) sendValve(1);
                setStatus(`Valve opened (${ts.formatStatus()})`, "green");
            }
        }
        function closeValve() {
            if (valveOpen) {
                valveOpen = false;
                if (!forceOpen) sendValve(0);
                setStatus(`Valve closed (${ts.formatStatus()})`, "grey");
            }
        }

        function scheduleClose(sec) {
            const remaining = Math.max(0, Math.floor(sec));
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
            }
            if (remaining > 0) {
                closeTimer = setTimeout(() => {
                    closeTimer = null;
                    closeValve();
                }, remaining * 1000);
            }
        }

        // External forces
        let forceOpen = false;
        let forceClose = false;

        // ---- Compute + act
        function computeAndAct(periodSec) {
            if (latestSetpoint == null || latestReturn == null) {
                setStatus(`Waiting inputs (${ts.formatStatus()})`, "grey");
                return;
            }
            if (!node._pi) {
                node.debug("PI not initialized yet");
                return;
            }

            if (typeof node._pi.setReferenceSample === "function" && pendingPeriodSec) {
                node._pi.setReferenceSample(pendingPeriodSec);
            }

            // Feedforward: adjust setpoint based on anticipated outdoor conditions (from iolayer)
            const ffAdj = computeFeedforward();
            const effectiveSetpoint = Number(latestSetpoint) + ffAdj;

            const error = effectiveSetpoint - Number(latestReturn);
            const pi = node._pi.step(coolingMode ? -error : error, { dtSec: periodSec });

            // Dew point protection for cooling mode
            if (coolingMode && typeof dewPointC === "number" && typeof effectiveSetpoint === "number") {
                const minSafe = dewPointC + node.dewMarginC;
                if (effectiveSetpoint < minSafe) {
                    closeValve();
                    setStatus(`Cooling limited (dew ${dewPointC.toFixed(1)} + ${node.dewMarginC} → ${minSafe.toFixed(1)}°C) (${ts.formatStatus()})`, "yellow");
                    // Log + save PI (still useful to persist integral)
                    const ffStr = ffAdj !== 0 ? ` ff=${ffAdj.toFixed(2)}` : "";
                    node.warn(`[floor-loop:${node.name}] compute: Tret=${latestReturn} SP=${latestSetpoint}${ffStr} e=${error} -> u=${pi}  P=${periodSec} (dew-limit)`);
                    if (node._pi && typeof node._pi.saveState === "function") {
                        node._pi.saveState();
                        node.debug(`[floor-loop:${node.name}] PI state saved after compute`);
                    }
                    return;
                }
            }

            const requestedOpenSec = Math.max(0, Number(pi) * Number(periodSec));
            const want = requestedOpenSec + carryoverSec;

            // If too short, carry to next period
            if (want < node.minOpenSec) {
                carryoverSec = want;
                const ffStr = ffAdj !== 0 ? ` ff=${ffAdj.toFixed(2)}` : "";
                setStatus(`Carryover ${carryoverSec.toFixed(0)}s${ffStr} (${ts.formatStatus()})`, "blue");
                node.log(
                    `[floor-loop:${node.name}] compute: Tret=${latestReturn} SP=${latestSetpoint}${ffStr} e=${error.toFixed(2)} -> u=${pi}  P=${periodSec} want=${want.toFixed(
                        0
                    )} open=0 carry=${Math.floor(carryoverSec)}`
                );
                if (node._pi && typeof node._pi.saveState === "function") {
                    node._pi.saveState();
                    node.debug(`[floor-loop:${node.name}] PI state saved after compute`);
                }
                return;
            }

            const openSec = Math.min(want, periodSec);
            carryoverSec = Math.max(0, want - openSec);

            openValve();
            scheduleClose(openSec);
            setStatus(`Last out: ${Math.floor(openSec)} (${new Date().toLocaleTimeString("en-GB", { hour12: false })})`, "green");

            // Log compute + persist PI state (mirror room-loop)
            const ffStr = ffAdj !== 0 ? ` ff=${ffAdj.toFixed(2)}` : "";
            node.log(
                `[floor-loop:${node.name}] compute: Tret=${latestReturn} SP=${latestSetpoint}${ffStr} e=${error.toFixed(2)} -> u=${pi}  P=${periodSec} ` +
                    `want=${want.toFixed(0)} open=${Math.floor(openSec)} carry=${Math.floor(carryoverSec)}`
            );
            if (node._pi && typeof node._pi.saveState === "function") {
                node._pi.saveState();
                node.debug(`[floor-loop:${node.name}] PI state saved after compute`);
            }
        }

        function handleTick(msg) {
            lastTickTs = Number(msg.payload.ts);
            pendingPeriodSec = Number(msg.payload.periodSec || 0);
            awaitingSetpointAfterTick = true;
            setStatus(`Tick received; waiting setpoint (${ts.formatStatus()})`, "blue");
            publishCurrentValveState();
            node.debug(`[floor-loop:${node.name}] tick ts=${lastTickTs} P=${pendingPeriodSec}`);
        }

        // ---- Input
        node.on("input", (msg) => {
            const t = msg.topic || "";

            // Tick from clock-ticker
            if (t === node.roomTickTopic && msg && typeof msg.payload === "object" && typeof msg.payload.ts === "number") {
                handleTick(msg);
                return;
            }

            if (t === node.setpointTopic) {
                latestSetpoint = Number(msg.payload);
                if (awaitingSetpointAfterTick && pendingPeriodSec) {
                    awaitingSetpointAfterTick = false;
                    computeAndAct(pendingPeriodSec);
                    pendingPeriodSec = 0;
                }
                return;
            }

            if (t === node.returnTopic) {
                latestReturn = Number(msg.payload);
                return;
            }

            if (t === node.roomErrorTopic) {
                roomErrorC = Number(msg.payload);
                return;
            }

            if (t === node.coolingModeTopic) {
                coolingMode = !!Number(msg.payload);
                return;
            }

            if (t === node.dewPointTopic) {
                dewPointC = Number(msg.payload);
                return;
            }

            if (t === node.forceOpenTopic) {
                forceOpen = !!Number(msg.payload);
                if (forceOpen) openValve();
                return;
            }

            if (t === node.forceCloseTopic) {
                forceClose = !!Number(msg.payload);
                if (forceClose) closeValve();
                return;
            }

            // Feedforward iolayer topics from forecast-publisher: FCTW.1, FCTW.2, FCWW.1, etc.
            if (node.ffEnable) {
                const toutPrefix = node.ffToutTopicPrefix + ".";
                const windPrefix = node.ffWindTopicPrefix + ".";

                if (t.startsWith(toutPrefix)) {
                    const member = t.slice(toutPrefix.length); // "1", "2", "3", "4"
                    ffIolayerCache.temp[member] = Number(msg.payload);
                    return;
                }
                if (t.startsWith(windPrefix)) {
                    const member = t.slice(windPrefix.length);
                    ffIolayerCache.wind[member] = Number(msg.payload);
                    return;
                }
            }
        });

        node.on("close", () => {
            if (closeTimer) clearTimeout(closeTimer);
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-floor-loop", FloorLoopNode);
};
