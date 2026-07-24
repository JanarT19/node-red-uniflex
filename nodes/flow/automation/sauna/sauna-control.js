const fs = require("fs");
const path = require("path");
const ts = require("../../core/lib/timestamp.js");

module.exports = function (RED) {
    function SaunaControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIGURATION ----
        node.name = config.name;
        node.tickMs = Number(config.tickMs || 1000);
        node.historyFilePath = (config.historyFilePath || "").trim();
        node.lidSpeedThreshold = Number(config.lidSpeedThreshold || 0.3);
        if (!Number.isFinite(node.lidSpeedThreshold) || node.lidSpeedThreshold < 0.03) {
            node.lidSpeedThreshold = 0.03;
        }
        node.lidTempThreshold = Number(config.lidTempThreshold || 37);
        if (!Number.isFinite(node.lidTempThreshold)) {
            node.lidTempThreshold = 37;
        }
        node.lidDetectionWindow = Number(config.lidDetectionWindow || 120);
        if (!Number.isFinite(node.lidDetectionWindow) || node.lidDetectionWindow < 10) {
            node.lidDetectionWindow = 10;
        }
        node.maxShellTemp = Number(config.maxShellTemp || 80);
        if (!Number.isFinite(node.maxShellTemp)) {
            node.maxShellTemp = 80;
        }
        node.tempDisplayUnit = config.tempDisplayUnit || "dC";
        node.humidityDisplayUnit = config.humidityDisplayUnit || "d%";
        node.enableLogging = config.enableLogging !== false; // Default to true

        // Input topics
        node.buttonTopic = config.buttonTopic || "";
        node.upperTempTopic = config.upperTempTopic || "";
        node.lowerTempTopic = config.lowerTempTopic || "";
        node.highLimitTopic = config.highLimitTopic || "";
        node.shellTempTopic = config.shellTempTopic || "";
        node.shellMaxTopic = config.shellMaxTopic || "";
        node.humidityTopTopic = config.humidityTopTopic || "";
        node.humidityBottomTopic = config.humidityBottomTopic || "";
        node.visitNeedTopic = config.visitNeedTopic || "";
        node.preheatForceTopic = config.preheatForceTopic || "";
        node.preheatDisableTopic = config.preheatDisableTopic || "";
        // Output topics
        node.heaterTopic = config.heaterTopic || "";
        node.visitTopic = config.visitTopic || "";
        node.displayTopic = config.displayTopic || "";
        node.preheatCalendarTopic = config.preheatCalendarTopic || "";

        const DEFAULT_TICK_MS = 1000;
        const MIN_TICK_MS = 200;
        const FORCE_OFF_DELAY_MS = 10000;

        function effectiveTickMs() {
            const raw = Number.isFinite(node.tickMs) ? Number(node.tickMs) : DEFAULT_TICK_MS;
            return Math.max(MIN_TICK_MS, raw);
        }

        // ---- STATE ----
        const defaults = {
            saunaOn: 0,
            saunaHeating: 0,
            preheatAllowed: 0,
            preheatForced: 0,
            preheatDisabled: 0,
            opened: false,
            openedSince: 0,
            upperTemp: null,
            lowerTemp: null,
            highLimit: 850,
            shellTemp: null,
            humidityTop: null,
            humidityBottom: null,
            lastUpperTemp: null,
            lastUpperTs: null,
            lastUpperTempInputTs: null,
            lastIncSpeed: 0,
            buttonState: null,
            ledCode: 0,
            rhLed: 0,
            tickCounter: 0,
            actualHeaterState: null,
            invalidOnTicks: 0,
            overrideWarned: false,
            overrideForced: false,
            lastCommandedOffTs: null,
            preheatHistory: [],
            preheatQuotaExceeded: false,
            detectingLid: false,
            detectStartTs: null,
            maxShellTemp: null,
            _visitNeed: null
        };

        const persisted = node.context().get("saunaState") || {};
        const state = { ...defaults, ...persisted };
        state.actualHeaterState = null;
        state.invalidOnTicks = 0;
        state.overrideWarned = false;
        state.overrideForced = false;
        state.preheatHistory = Array.isArray(state.preheatHistory) ? state.preheatHistory : [];
        state.preheatQuotaExceeded = !!state.preheatQuotaExceeded;
        state.detectingLid = !!state.detectingLid;
        state.detectStartTs = Number.isFinite(state.detectStartTs) ? state.detectStartTs : null;
        if (!Number.isFinite(state.maxShellTemp)) {
            state.maxShellTemp = node.maxShellTemp;
        }

        const lastSent = {};
        let tickTimer = null;
        const displayRows = state.displayRows || { top: null, bottom: null, mode: null };
        const displayCache = state.displayCache || { top: null, bottom: null };
        let heaterMismatchActive = false;
        let prevQuotaExceededLogged = null;
        let lastPreheatBlockedKey = null;
        const startupGraceUntilMs = Date.now() + 15000;
        state.displayRows = displayRows;
        state.displayCache = displayCache;
        const LID_DETECTION_WINDOW_SEC = node.lidDetectionWindow;

        // ---- HELPERS ----
        function savePersistentState() {
            node.context().set("saunaState", {
                saunaOn: state.saunaOn,
                saunaHeating: state.saunaHeating,
                preheatAllowed: state.preheatAllowed,
                preheatForced: state.preheatForced,
                preheatDisabled: state.preheatDisabled,
                opened: state.opened,
                openedSince: state.openedSince,
                lastUpperTemp: state.lastUpperTemp,
                lastUpperTs: state.lastUpperTs,
                lastUpperTempInputTs: state.lastUpperTempInputTs,
                lastIncSpeed: state.lastIncSpeed,
                ledCode: state.ledCode,
                rhLed: state.rhLed,
                tickCounter: state.tickCounter,
                invalidOnTicks: state.invalidOnTicks,
                overrideWarned: state.overrideWarned,
                overrideForced: state.overrideForced,
                preheatHistory: state.preheatHistory,
                preheatQuotaExceeded: state.preheatQuotaExceeded,
                detectingLid: state.detectingLid,
                detectStartTs: state.detectStartTs,
                lidSpeedThreshold: node.lidSpeedThreshold,
                lidTempThreshold: node.lidTempThreshold,
                lidDetectionWindow: node.lidDetectionWindow,
                displayRows,
                displayCache
            });
        }

        function toNumber(value) {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        }

        function extractNumeric(value) {
            if (value === null || value === undefined) return null;
            if (Array.isArray(value)) {
                for (const item of value) {
                    const num = toNumber(item);
                    if (num !== null) return num;
                }
                return null;
            }
            if (typeof value === "object") {
                if (value.payload !== undefined) return extractNumeric(value.payload);
                if (value.value !== undefined) return toNumber(value.value);
                if (Array.isArray(value.values)) return extractNumeric(value.values);
                if (value.data !== undefined) return extractNumeric(value.data);
                if (value[0] !== undefined) return toNumber(value[0]);
                return null;
            }
            return toNumber(value);
        }

        function extractTimestamp(value) {
            if (value && typeof value === "object") {
                if (Number.isFinite(value.timestamp)) return Number(value.timestamp);
                if (Number.isFinite(value.ts)) return Number(value.ts);
            }
            return null;
        }

        function parseMessage(msg) {
            const payload = msg?.payload;
            const value = extractNumeric(payload);
            const ts = extractTimestamp(payload);
            return { value, ts };
        }

        function setStatus(text, fill = "blue") {
            node.status({ fill, shape: "dot", text });
        }

        function publish(topic, payload, force = false) {
            if (!topic) return;
            if (!force && lastSent[topic] === payload) return;
            lastSent[topic] = payload;
            node.send({ topic, payload });
        }

        function getPreheatStatus() {
            const effective = effectivePreheatAllowed();
            let mode = "off";
            if (state.preheatForced) mode = "forced";
            else if (state.preheatDisabled) mode = "disabled";
            else if (state.preheatAllowed) mode = "calendar";

            if (mode === "forced" || mode === "calendar") {
                if (state.saunaHeating === 1) return `${mode}-heating`;
                if (state.preheatQuotaExceeded) return `${mode}-blocked`;
                if (effective === 1) return `${mode}-waiting`;
            }
            return mode;
        }

        function baselineStatusText() {
            const nowSec = Math.floor(Date.now() / 1000);
            const usedMin = totalPreheatSeconds(nowSec) / 60;
            const remainingMin = Math.max(0, 60 - usedMin);
            return `visit:${state.saunaOn} heat:${state.saunaHeating} preheat:${getPreheatStatus()} qRem:${remainingMin.toFixed(1)}m lid:${state.opened ? "open" : "closed"}`;
        }

        function applyBaselineStatus() {
            const text = baselineStatusText();
            const preheatStatus = getPreheatStatus();
            const color = state.saunaHeating ? "green" : preheatStatus.includes("blocked") ? "red" : "grey";
            setStatus(text, color);
            // Log only when meaningful state changes (exclude qRem fluctuations)
            if (node.enableLogging) {
                const logKey = `visit:${state.saunaOn} heat:${state.saunaHeating} preheat:${getPreheatStatus()} lid:${state.opened ? "open" : "closed"}`;
                if (logKey !== node._lastLogKey) {
                    node._lastLogKey = logKey;
                    node.warn(`[${node.name || "sauna-control"}] Status: ${text}`);
                }
            }
        }

        function effectivePreheatAllowed() {
            // Forced OFF takes priority: if active, clear forced ON and disable preheat
            if (state.preheatDisabled) {
                if (state.preheatForced) {
                    state.preheatForced = 0;
                    logEvent("warn", "Forced OFF active - clearing forced ON");
                }
                return 0;
            }
            if (state.preheatForced) return 1;
            return state.preheatAllowed ? 1 : 0;
        }

        function publishControlStates() {
            // Heater: republish if feedback doesn't match desired state
            if (node.heaterTopic) {
                const desiredHeater = state.saunaHeating;
                const actualHeater = state.actualHeaterState;

                if (actualHeater !== null && actualHeater !== desiredHeater) {
                    // On first mismatch: send command once and schedule up to MAX_MISMATCH_RETRIES retries.
                    // Avoid re-sending every tick - trust DI change detection for confirmation.
                    const MAX_MISMATCH_RETRIES = 3;
                    const RETRY_INTERVAL_MS = 30000;

                    if (!state._mismatchFirstSent) {
                        state._mismatchFirstSent = Date.now();
                        state._mismatchRetryCount = 0;
                        publish(node.heaterTopic, desiredHeater, true);
                        logEvent("warn", `Heater mismatch: desired=${desiredHeater}, actual=${actualHeater}, sending command`);

                        const scheduleRetry = () => {
                            setTimeout(() => {
                                if (state.saunaHeating === state.actualHeaterState) {
                                    // Mismatch resolved - nothing to do
                                    state._mismatchFirstSent = null;
                                    state._mismatchRetryCount = 0;
                                    return;
                                }
                                state._mismatchRetryCount = (state._mismatchRetryCount || 0) + 1;
                                publish(node.heaterTopic, state.saunaHeating, true);
                                logEvent(
                                    "warn",
                                    `Heater mismatch retry ${state._mismatchRetryCount}/${MAX_MISMATCH_RETRIES}: desired=${state.saunaHeating}, actual=${state.actualHeaterState}`
                                );
                                if (state._mismatchRetryCount < MAX_MISMATCH_RETRIES) {
                                    scheduleRetry();
                                } else {
                                    logEvent("warn", `Heater mismatch unresolved after ${MAX_MISMATCH_RETRIES} retries - giving up`);
                                    state._mismatchFirstSent = null;
                                    state._mismatchRetryCount = 0;
                                }
                            }, RETRY_INTERVAL_MS);
                        };
                        scheduleRetry();
                    }
                } else {
                    // Normal publish (uses cache to avoid duplicates)
                    publish(node.heaterTopic, desiredHeater);
                    state._mismatchFirstSent = null;
                    state._mismatchRetryCount = 0;
                }
            }

            publish(node.visitTopic, state.saunaOn);
        }

        function logEvent(level, message) {
            if (!node.enableLogging) return; // Skip logging if disabled
            if (level === "error") node.error(message);
            else if (level === "warn") node.warn(message);
            else node.log(message);
        }

        function buildHeaterSwitchReason(newValue, contextMessage) {
            const stateStr = newValue ? "ON" : "OFF";
            const parts = [];

            // Mode identification
            if (state.saunaOn === 1) {
                parts.push("visit mode");
            } else {
                const preheatMode = getPreheatStatus();
                if (preheatMode.includes("forced")) {
                    parts.push("preheat (forced)");
                } else if (preheatMode.includes("calendar")) {
                    parts.push("preheat (calendar)");
                } else if (preheatMode.includes("blocked")) {
                    parts.push("preheat (blocked)");
                } else {
                    parts.push("preheat (disabled)");
                }
            }

            // Temperature context
            const tempInfo = [];
            if (state.upperTemp !== null) {
                tempInfo.push(`upper=${state.upperTemp} dC`);
            }
            if (state.shellTemp !== null) {
                tempInfo.push(`shell=${state.shellTemp} dC`);
            }
            if (state.highLimit !== null) {
                tempInfo.push(`highLimit=${state.highLimit} dC`);
            }
            if (state.maxShellTemp !== null) {
                tempInfo.push(`maxShell=${state.maxShellTemp} dC`);
            }
            if (tempInfo.length > 0) {
                parts.push(tempInfo.join(", "));
            }

            // Lid state
            if (state.saunaOn === 1) {
                parts.push(`lid=${state.opened ? "open" : "closed"}`);
            }

            // Safety conditions
            if (state.shellTemp !== null && state.maxShellTemp !== null && state.shellTemp > state.maxShellTemp) {
                parts.push(`(safety: shell ${state.shellTemp} > max ${state.maxShellTemp})`);
            }
            if (state.upperTemp !== null && state.highLimit !== null && state.upperTemp >= state.highLimit) {
                parts.push(`(limit: upper ${state.upperTemp} >= highLimit ${state.highLimit})`);
            }

            // Custom context message
            if (contextMessage) {
                parts.push(`- ${contextMessage}`);
            }

            return `Heater ${stateStr} (${parts.join(", ")})`;
        }

        function logHeaterSwitch(eventType, reason) {
            if (!node.historyFilePath) return;

            // Format timestamp: "2025-11-15 09:14:46" (YYYY-MM-DD HH:MM:SS in local time)
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            const hours = String(now.getHours()).padStart(2, "0");
            const minutes = String(now.getMinutes()).padStart(2, "0");
            const seconds = String(now.getSeconds()).padStart(2, "0");
            const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

            // eventType: ON_cmd, OFF_cmd, ON_fb, OFF_fb
            const line = `${timestamp},${eventType},${reason}\n`;

            fs.appendFile(node.historyFilePath, line, (err) => {
                if (err) {
                    logEvent("warn", `Failed to write heater history: ${err.message}`);
                }
            });
        }

        function classifyActualHeaterReason(actualValue) {
            if (actualValue === 1) {
                if (state.saunaOn === 1) return "visit";
                if (state.preheatForced === 1) return "preheat_forced";
                if (effectivePreheatAllowed() === 1) return "preheat";
                return "unexpected_on";
            }
            if (state.saunaOn === 1) return "visit_off";
            if (effectivePreheatAllowed() === 1 || state.preheatForced === 1) return "preheat_off";
            return "off";
        }

        function updateHeaterDeliveryMismatch() {
            if (state.actualHeaterState === null) return;
            const mismatch = state.saunaHeating !== state.actualHeaterState;
            if (mismatch && !heaterMismatchActive) {
                logEvent("warn", `Heater command mismatch started: desired=${state.saunaHeating}, actual=${state.actualHeaterState}`);
            } else if (!mismatch && heaterMismatchActive) {
                logEvent("log", `Heater command mismatch cleared: desired=${state.saunaHeating}, actual=${state.actualHeaterState}`);
            }
            heaterMismatchActive = mismatch;
        }

        function updateActualHeaterState(feedback, source) {
            const prev = state.actualHeaterState;
            if (prev !== feedback) {
                state.actualHeaterState = feedback;
                logEvent("warn", `Heater feedback ${feedback ? "ON" : "OFF"} (SAKW.1, ${source || "feedback"})`);
                // Skip logging to history when just initializing from null (first SAKW.1=0 on startup)
                if (prev !== null || feedback === 1) {
                    logHeaterSwitch(feedback ? "ON_fb" : "OFF_fb", classifyActualHeaterReason(feedback));
                }
            } else {
                state.actualHeaterState = feedback;
            }
            updateHeaterDeliveryMismatch();
        }

        function ensureHighLimitBounds() {
            if (state.highLimit !== null && state.highLimit > 850) {
                logEvent("warn", `High limit capped to 850 dC (was ${state.highLimit})`);
                state.highLimit = 850;
                if (node.highLimitTopic) publish(node.highLimitTopic, state.highLimit);
            }
        }

        function updateLidState(currentTemp, tsSeconds) {
            if (currentTemp === null) return;
            const nowSec = Number.isFinite(tsSeconds) ? tsSeconds : Math.floor(Date.now() / 1000);

            const detectionActive = state.saunaOn === 1 && state.saunaHeating === 0 && !state.opened;

            if (detectionActive && !state.detectingLid) {
                state.detectingLid = true;
                state.detectStartTs = nowSec;
                logEvent("warn", "Lid open detection started (monitoring upper temperature)");
                refreshDisplayRows();
                logEvent("warn", `Initial upper temperature ${displayRows.top ?? "?"} dC`);
            } else if (!detectionActive && state.detectingLid) {
                state.detectingLid = false;
                state.detectStartTs = null;
            }

            if (detectionActive && state.detectStartTs !== null && nowSec > state.detectStartTs + LID_DETECTION_WINDOW_SEC) {
                state.detectingLid = false;
                state.detectStartTs = null;
                logEvent("warn", "Lid open detection window elapsed without temperature rise");
            }

            if (detectionActive && state.lastUpperTemp !== null && state.lastUpperTs !== null) {
                const dt = nowSec - state.lastUpperTs;
                if (dt > 0 && dt <= LID_DETECTION_WINDOW_SEC) {
                    const delta = currentTemp - state.lastUpperTemp;
                    const incSpeed = delta / dt;
                    state.lastIncSpeed = incSpeed;

                    logEvent("warn", `Lid open detection sample temp=${currentTemp} dC d=${delta.toFixed(2)} degC over ${dt}s (${incSpeed.toFixed(3)} degC/s)`);

                    const tempRiseSatisfied = delta > 0 && incSpeed > node.lidSpeedThreshold && incSpeed <= 2;
                    const highAbsoluteTemp = currentTemp > node.lidTempThreshold;

                    if (tempRiseSatisfied || highAbsoluteTemp) {
                        logEvent("info", `Lid assumed OPEN (d ${incSpeed.toFixed(3)} degC/s, temp ${currentTemp} dC)`);
                        state.opened = true;
                        state.openedSince = nowSec;
                        state.detectingLid = false;
                        state.detectStartTs = null;
                        // Update status immediately when lid state changes
                        applyBaselineStatus();
                    }
                }
            }

            if (state.lastUpperTemp !== null) {
                const rawDelta = Math.abs(currentTemp - state.lastUpperTemp);
                if (rawDelta > 1) {
                    logEvent("warn", `Upper sauna sensor jump ${rawDelta.toFixed(2)} degC (prev ${state.lastUpperTemp} -> now ${currentTemp})`);
                }
            }

            state.lastUpperTemp = currentTemp;
            state.lastUpperTs = nowSec;
        }

        function closeLid(reason) {
            if (state.opened) {
                state.opened = false;
                state.openedSince = null;
                if (reason) logEvent("info", reason);
                // Update status immediately when lid state changes
                applyBaselineStatus();
            }
            state.detectingLid = false;
            state.detectStartTs = null;
        }

        function resetOverrideState() {
            if (state.invalidOnTicks !== 0 || state.overrideWarned || state.overrideForced) {
                const wasForced = state.overrideForced;
                state.invalidOnTicks = 0;
                state.overrideWarned = false;
                state.overrideForced = false;
                if (wasForced) {
                    logEvent("log", "Heater override cleared - state now valid");
                }
                applyBaselineStatus();
            }
        }

        function prunePreheatHistory(nowSec) {
            const cutoff = nowSec - 24 * 3600;
            state.preheatHistory = state.preheatHistory.filter((entry) => entry.ts >= cutoff);
        }

        function addPreheatDuration(seconds, nowSec) {
            if (!Number.isFinite(seconds) || seconds <= 0) return;
            prunePreheatHistory(nowSec);
            state.preheatHistory.push({ ts: nowSec, dur: seconds });
        }

        function totalPreheatSeconds(nowSec) {
            prunePreheatHistory(nowSec);
            return state.preheatHistory.reduce((sum, entry) => sum + entry.dur, 0);
        }

        function recalculateQuotaFromHistory() {
            if (!node.historyFilePath) return;

            try {
                const nowSec = Math.floor(Date.now() / 1000);
                const persistedSec = totalPreheatSeconds(nowSec);
                const persistedHistorySnapshot = state.preheatHistory.slice();

                if (!fs.existsSync(node.historyFilePath)) {
                    logEvent("log", "Heater history file not found, starting with empty quota");
                    return;
                }

                const data = fs.readFileSync(node.historyFilePath, "utf8");
                const lines = data.split("\n").filter((line) => line.trim());
                const cutoff24h = nowSec - 24 * 3600;

                // Parse history file.
                // New format: timestamp,ON_cmd|OFF_cmd|ON_fb|OFF_fb,reason,{context_json}
                // Legacy format: timestamp,ON|OFF,reason,{context_json}  (treated as _fb)
                // Only preheat sessions (reason contains "preheat" or "calendar-heating") count toward quota.
                // Session duration: start = ON_fb (or ON_cmd fallback), end = OFF_cmd (or OFF_fb fallback).
                // Open preheat at EOF: on NR restart, trust persisted tick quota (not wall clock to now).

                // Collect all parsed events in window
                const events = [];
                for (const line of lines) {
                    const parts = line.split(",");
                    if (parts.length < 3) continue;

                    const timestampStr = parts[0].trim();
                    const eventType = parts[1].trim(); // ON_cmd, OFF_cmd, ON_fb, OFF_fb, ON, OFF (legacy)
                    const reason = parts[2].trim();

                    const [datePart, timePart] = timestampStr.split(" ");
                    if (!datePart || !timePart) continue;

                    const [year, month, day] = datePart.split("-").map(Number);
                    const [hours, minutes, secs] = timePart.split(":").map(Number);
                    if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hours) || isNaN(minutes) || isNaN(secs)) continue;

                    const lineTs = Math.floor(new Date(year, month - 1, day, hours, minutes, secs).getTime() / 1000);
                    if (lineTs < cutoff24h) continue;

                    // Normalise legacy ON/OFF to _fb
                    let normType = eventType;
                    if (normType === "ON") normType = "ON_fb";
                    else if (normType === "OFF") normType = "OFF_fb";

                    const isOn = normType === "ON_cmd" || normType === "ON_fb";
                    const isOff = normType === "OFF_cmd" || normType === "OFF_fb";
                    const isCmd = normType === "ON_cmd" || normType === "OFF_cmd";
                    const isFb = normType === "ON_fb" || normType === "OFF_fb";

                    const isPreheatReason = /preheat/i.test(reason);

                    events.push({ ts: lineTs, normType, isOn, isOff, isCmd, isFb, isPreheatReason, reason });
                }

                // Pair events to compute preheat duration.
                // Track: pending session start (from ON_fb preferred, ON_cmd fallback).
                // Close session on: OFF_cmd preferred, OFF_fb fallback.
                // Session type (preheat vs visit) is determined from the ON event reason, not the OFF event.
                let sessionOnFb = null; // ts of ON_fb
                let sessionOnCmd = null; // ts of ON_cmd (fallback start)
                let sessionIsPreheat = false; // set from ON event reason
                let offCmdPending = null; // ts of first OFF_cmd after session start
                let totalPreheatSec = 0;

                const closeSession = (offTs) => {
                    if (sessionIsPreheat) {
                        const onTs = sessionOnFb !== null ? sessionOnFb : sessionOnCmd;
                        if (onTs !== null && offTs > onTs) {
                            totalPreheatSec += offTs - onTs;
                        }
                    }
                    sessionOnFb = null;
                    sessionOnCmd = null;
                    sessionIsPreheat = false;
                    offCmdPending = null;
                };

                for (const ev of events) {
                    if (ev.isOn) {
                        // New session start
                        if (sessionOnFb !== null || sessionOnCmd !== null) {
                            // Unmatched previous ON - close it at the new ON timestamp
                            logEvent("warn", `Unmatched heater ON in history at ts=${sessionOnFb ?? sessionOnCmd}, resetting`);
                            closeSession(ev.ts);
                        }
                        if (ev.normType === "ON_fb") sessionOnFb = ev.ts;
                        else sessionOnCmd = ev.ts; // ON_cmd
                        // Classify session type from ON reason - visit sessions don't count toward quota
                        sessionIsPreheat = ev.isPreheatReason;
                        offCmdPending = null;
                    } else if (ev.isOff) {
                        if (sessionOnFb === null && sessionOnCmd === null) continue; // no active session
                        if (ev.isCmd) {
                            // OFF_cmd: close session immediately (authoritative end)
                            closeSession(ev.ts);
                        } else {
                            // OFF_fb: hold until we get OFF_cmd or end of log
                            if (offCmdPending === null) offCmdPending = ev.ts;
                        }
                    }
                }

                const hasOpenSession = sessionOnFb !== null || sessionOnCmd !== null;
                const openOnTs = hasOpenSession ? (sessionOnFb !== null ? sessionOnFb : sessionOnCmd) : null;
                const openIsPreheat = hasOpenSession && sessionIsPreheat;
                let finalPreheatSec = totalPreheatSec;

                if (hasOpenSession && !openIsPreheat) {
                    // Open visit/unclassified session - ignore for preheat quota
                    if (offCmdPending !== null) closeSession(offCmdPending);
                } else if (openIsPreheat) {
                    // NR restart mid-preheat: do not credit wall clock from ON to now in one lump.
                    if (persistedSec > 0) {
                        finalPreheatSec = Math.max(totalPreheatSec, persistedSec);
                        state.preheatHistory = persistedHistorySnapshot;
                        prunePreheatHistory(nowSec);
                        finalPreheatSec = totalPreheatSeconds(nowSec);
                        logEvent("log", `Open preheat at restart: using persisted ${(finalPreheatSec / 60).toFixed(1)} min`);
                    } else {
                        // Context lost (deploy): credit closed sessions only; resume tick counting after reconcile
                        finalPreheatSec = totalPreheatSec;
                        state.preheatHistory = finalPreheatSec > 0 ? [{ ts: nowSec - Math.floor(finalPreheatSec / 2), dur: finalPreheatSec }] : [];
                        logEvent("log", "Open preheat in log, no persisted quota - closed sessions only until reconcile");
                    }
                } else {
                    finalPreheatSec = Math.max(totalPreheatSec, persistedSec);
                    if (persistedSec > finalPreheatSec) {
                        state.preheatHistory = persistedHistorySnapshot;
                        prunePreheatHistory(nowSec);
                        finalPreheatSec = totalPreheatSeconds(nowSec);
                    } else if (finalPreheatSec > 0) {
                        state.preheatHistory = [{ ts: nowSec - Math.floor(finalPreheatSec / 2), dur: finalPreheatSec }];
                    } else {
                        state.preheatHistory = [];
                    }
                }

                // Update quota state
                state.preheatQuotaExceeded = finalPreheatSec >= 3600;
                const minutesUsed = Math.round(finalPreheatSec / 60);

                if (state.preheatQuotaExceeded) {
                    logEvent("warn", `Quota recalculated from history: ${minutesUsed} min used (quota exceeded)`);
                } else {
                    logEvent("log", `Quota recalculated from history: ${minutesUsed} min used`);
                }
            } catch (err) {
                logEvent("warn", `Failed to recalculate quota from history: ${err.message}`);
            }
        }

        function handleHeaterOverride() {
            if (state.actualHeaterState === null) {
                return;
            }

            // Only detect unauthorized "forced ON" when no visit is active and NR has not commanded heat.
            // During a visit, heater=physical-ON while saunaHeating=0 is normal Modbus transition lag.
            const conflicting = state.actualHeaterState === 1 && state.saunaHeating === 0 && state.saunaOn === 0;

            if (!conflicting) {
                resetOverrideState();
                return;
            }

            // Grace period after a legitimate OFF command: allow time for Modbus feedback to arrive.
            // 30s covers any realistic Modbus/IO-layer response delay.
            const nowSec = Math.floor(Date.now() / 1000);
            const gracePeriodSec = 30;
            if (state.lastCommandedOffTs !== null && nowSec - state.lastCommandedOffTs < gracePeriodSec) {
                // Within grace period, don't trigger override detection
                return;
            }

            const requiredTicks = Math.max(1, Math.ceil(FORCE_OFF_DELAY_MS / effectiveTickMs()));
            state.invalidOnTicks = Math.min(state.invalidOnTicks + 1, requiredTicks + 1);

            if (!state.overrideWarned) {
                state.overrideWarned = true;
                logEvent("warn", "Forced heater ON detected, will cancel soon");
            }
            setStatus("Forced heater ON detected; cancelling soon", "red");

            if (state.invalidOnTicks >= requiredTicks) {
                if (!state.overrideForced) {
                    state.overrideForced = true;
                    logEvent("error", "Heater ON without visit/preheat - forcing OFF");
                }
                publish(node.heaterTopic, 0, true);
                setStatus("Forced heater OFF (invalid state)", "red");
            }
        }

        function computeLedValue() {
            let ledCode = state.ledCode;

            if (state.saunaOn === 1 && state.saunaHeating === 1) {
                // Visit mode with heating active: animated LEDs
                ledCode = (1 << (state.tickCounter + 1)) - 1;
            } else if (state.saunaOn === 0 && state.saunaHeating === 1) {
                // Preheat mode: animated LEDs
                ledCode = (1 << (state.tickCounter + 1)) - 1;
            } else if (state.saunaOn === 1 && state.saunaHeating === 0 && !state.opened) {
                // Visit mode, waiting for lid open detection: all LEDs ON
                ledCode = 15;
            } else {
                // All other cases (heating stopped, no visit): LEDs OFF
                ledCode = 0;
            }

            if (ledCode > 15) ledCode = state.saunaOn;

            const changed = ledCode !== state.ledCode;
            state.ledCode = ledCode;
            const ledValue = (ledCode << 2) + state.rhLed;
            return { ledCode, ledValue, changed };
        }

        function refreshDisplayRows() {
            if (state.rhLed === 0) {
                displayRows.top = state.upperTemp;
                displayRows.bottom = state.lowerTemp;
            } else {
                displayRows.top = state.humidityTop;
                displayRows.bottom = state.humidityBottom;
            }
            displayRows.mode = state.rhLed;

            if (displayRows.top === null || displayRows.bottom === null) {
                displayCache.top = null;
                displayCache.bottom = null;
                return;
            }

            if (state.rhLed === 0) {
                displayCache.top = node.tempDisplayUnit === "dC" ? Math.round(displayRows.top * 10) : Math.round(displayRows.top);
                displayCache.bottom = node.tempDisplayUnit === "dC" ? Math.round(displayRows.bottom * 10) : Math.round(displayRows.bottom);
            } else {
                displayCache.top = node.humidityDisplayUnit === "d%" ? Math.round(displayRows.top * 10) : Math.round(displayRows.top);
                displayCache.bottom = node.humidityDisplayUnit === "d%" ? Math.round(displayRows.bottom * 10) : Math.round(displayRows.bottom);
            }
        }

        function sendDisplay(ledValue) {
            if (!node.displayTopic) return;
            if (displayCache.top === null || displayCache.bottom === null) return;

            const payload = [ledValue, displayCache.top, displayCache.bottom];
            publish(node.displayTopic, payload, true);
        }

        function setSaunaHeating(newValue, contextMessage) {
            const value = newValue ? 1 : 0;
            if (state.saunaHeating !== value) {
                state.saunaHeating = value;
                // Update status immediately when heating state changes
                applyBaselineStatus();

                // Build detailed reason for system log
                const detailedReason = buildHeaterSwitchReason(value, contextMessage);
                logEvent("warn", detailedReason);

                // Log command intent to heater history file (short contextMessage, no JSON blob)
                logHeaterSwitch(value ? "ON_cmd" : "OFF_cmd", contextMessage || (value ? "on" : "off"));

                if (value === 0) {
                    // Track when we commanded OFF to avoid false positive forced ON detection
                    state.lastCommandedOffTs = Math.floor(Date.now() / 1000);
                }
            }
            updateHeaterDeliveryMismatch();
            if (value === 1) {
                resetOverrideState();
            } else {
                handleHeaterOverride();
            }
        }

        function setVisit(newValue, contextMessage) {
            const value = newValue ? 1 : 0;
            if (state.saunaOn !== value) {
                state.saunaOn = value;
                if (contextMessage) logEvent("warn", contextMessage);
                if (value === 0) {
                    closeLid("Lid closed (visit toggle off)");
                    if (state.saunaHeating === 1) {
                        setSaunaHeating(0, "off");
                    }
                }
                // Update status immediately when visit state changes
                applyBaselineStatus();
            }
            if (value === 1) {
                resetOverrideState();
            }
        }

        function handleControlTick(nowSec) {
            ensureHighLimitBounds();

            const upper = state.upperTemp;
            const shell = state.shellTemp;

            const now = nowSec;
            const effectivePreheat = effectivePreheatAllowed();
            const usedSec24h = totalPreheatSeconds(now);
            const usedMin24h = usedSec24h / 60;
            state.preheatQuotaExceeded = usedSec24h >= 3600;
            if (prevQuotaExceededLogged !== state.preheatQuotaExceeded) {
                if (state.preheatQuotaExceeded) {
                    logEvent("warn", `Preheat quota entered: used=${usedMin24h.toFixed(1)} min / 60.0 min`);
                } else if (prevQuotaExceededLogged !== null) {
                    logEvent("log", `Preheat quota cleared: used=${usedMin24h.toFixed(1)} min / 60.0 min`);
                }
                prevQuotaExceededLogged = state.preheatQuotaExceeded;
            }

            // Safety: Check if upper temp input has timed out (5 minutes = 300 seconds)
            const upperTempTimeout = 300;
            if (state.saunaHeating === 1 && state.lastUpperTempInputTs !== null && nowSec - state.lastUpperTempInputTs > upperTempTimeout) {
                logEvent("warn", `No upper temp input for ${upperTempTimeout}s - forcing heater OFF for safety`);
                setSaunaHeating(0, "off");
            }

            // Forced OFF disables all heating (visit and preheat)
            if (state.preheatDisabled) {
                if (state.saunaHeating === 1) {
                    setSaunaHeating(0, "off");
                }
                // Don't process visit or preheat logic when forced OFF is active
            } else if (state.saunaOn === 1) {
                // VISIT MODE: Handle visit heating logic
                // To start heating during visit: lid open AND sauna temp below max (only when visit starts, no auto-reheating)
                // To stop heating and end visit: sauna temp reached max OR button press

                // Check if temperature reached max - end visit mode to prevent auto-reheating
                if (upper !== null && state.highLimit !== null && upper >= state.highLimit) {
                    // Temperature reached max: stop heating and end visit mode
                    if (state.saunaHeating === 1) {
                        setSaunaHeating(0, "off");
                    }
                    setVisit(0, `Visit ended (temperature reached max: ${upper} >= ${state.highLimit})`);
                } else {
                    // Temperature below max - check if we should start heating
                    // Only start heating if: lid is open, temp is below max, and heater is currently off
                    // No auto-reheating - once visit mode ends (due to max temp), it won't restart automatically
                    const visitCanHeat = state.opened && upper !== null && state.highLimit !== null && upper < state.highLimit;

                    if (visitCanHeat && state.saunaHeating === 0) {
                        // Start visit heating (only when visit mode is first activated and conditions are met)
                        setSaunaHeating(1, `Heater ON (visit) upper=${upper} hilim=${state.highLimit} lid=${state.opened}`);
                    }
                    // Note: If temperature reaches max, visit mode ends (see above), preventing auto-reheating
                    // User must press button again to restart visit mode, which will allow heating to start again if conditions are met
                }
                // Note: Button press to stop visit is handled in setVisit(), which sets saunaOn=0
                // After that, preheat logic will take over if applicable
            } else {
                // NO VISIT MODE: Handle preheat logic
                // To start preheating: no preheatDisabled AND shell temp below max AND (button/calendar/forced)
                // To stop preheating: button press OR shell temp reached max OR calendar deactivation OR quota

                const isForced = state.preheatForced === 1;
                const shellTempSafe = shell === null || state.maxShellTemp === null || shell <= state.maxShellTemp;
                const preheatSeconds24h = totalPreheatSeconds(now);
                const quotaReached = preheatSeconds24h >= 3600;

                // Check if preheat should be active (forced bypasses lid check)
                const canPreheat = effectivePreheat === 1 && shellTempSafe;

                // Only log when preheat is wanted but blocked, or when conditions are met
                // Don't spam logs when preheat is simply not active
                if (node.enableLogging && state.saunaHeating === 0) {
                    if (effectivePreheat === 1) {
                        // Preheat is wanted - log why it's blocked or that it's allowed
                        if (!shellTempSafe) {
                            const blockedKey = `shell:${shell}:${state.maxShellTemp}`;
                            if (lastPreheatBlockedKey !== blockedKey) {
                                lastPreheatBlockedKey = blockedKey;
                                logEvent("warn", `Preheat blocked: shell temp ${shell} dC > max ${state.maxShellTemp} dC`);
                            }
                        } else if (state.preheatQuotaExceeded) {
                            const blockedKey = "quota";
                            if (lastPreheatBlockedKey !== blockedKey && Date.now() >= startupGraceUntilMs) {
                                lastPreheatBlockedKey = blockedKey;
                                logEvent("warn", "Preheat blocked: quota exceeded");
                            }
                        } else {
                            lastPreheatBlockedKey = null;
                            logEvent("log", `Preheat conditions met: effectivePreheat=${effectivePreheat}, shellTempSafe=${shellTempSafe}, canPreheat=${canPreheat}`);
                        }
                    }
                    // Only log "not wanted" once when state changes, not every tick
                }

                // CRITICAL: Check if heater should be OFF first (before checking if it should start)
                // This ensures we stop heating immediately when conditions are no longer met
                if (state.saunaHeating === 1 && !canPreheat) {
                    // Stop preheat heating (shell temp reached max, or preheat disabled/deactivated)
                    if (shell !== null && state.maxShellTemp !== null && shell > state.maxShellTemp) {
                        logEvent("warn", `Shell temp ${shell} dC above limit ${state.maxShellTemp} dC - forcing heater OFF`);
                    } else if (effectivePreheat === 0) {
                        logEvent(
                            "warn",
                            `Preheat deactivated (effectivePreheat=${effectivePreheat}, preheatAllowed=${state.preheatAllowed}, preheatForced=${state.preheatForced}, preheatDisabled=${state.preheatDisabled}) - forcing heater OFF`
                        );
                    }
                    setSaunaHeating(0, "off");
                } else if (state.saunaHeating === 1 && canPreheat && quotaReached) {
                    // Quota enforcement while already heating: cut immediately and reset forced flag if active.
                    const usedMin = (preheatSeconds24h / 60).toFixed(1);
                    if (!state.preheatQuotaExceeded) {
                        logEvent("warn", `Preheat quota reached while heating (used=${usedMin} min / 60.0 min), forcing heater OFF`);
                    }
                    state.preheatQuotaExceeded = true;
                    setSaunaHeating(0, "off");
                    if (isForced && node.preheatForceTopic) {
                        state.preheatForced = 0;
                        publish(node.preheatForceTopic, 0);
                        logEvent("warn", "Forced ON reset due to quota exceeded");
                    }
                } else if (canPreheat && state.saunaHeating === 0) {
                    // Start preheat heating (only if conditions are met AND heater is currently off)
                    if (quotaReached) {
                        const usedMin = (preheatSeconds24h / 60).toFixed(1);
                        if (!state.preheatQuotaExceeded) {
                            logEvent("warn", `Preheat quota reached (used=${usedMin} min / 60.0 min), blocking preheat`);
                        }
                        state.preheatQuotaExceeded = true;
                        setSaunaHeating(0, "off");
                        // If forced preheat is active, output 0 to reset the command (only if it's not already 0)
                        if (isForced && state.preheatForced === 1 && node.preheatForceTopic) {
                            state.preheatForced = 0;
                            publish(node.preheatForceTopic, 0);
                            logEvent("warn", "Forced ON reset due to quota exceeded");
                        }
                    } else {
                        const wasExceeded = state.preheatQuotaExceeded;
                        state.preheatQuotaExceeded = false;
                        if (wasExceeded) {
                            logEvent("log", "Preheat quota reset - heating allowed again");
                        }
                        setSaunaHeating(1, isForced ? "Heater ON (preheat forced)" : "Heater ON (preheat)");
                    }
                }
            }

            // Runtime quota: count only while NR commands heating (not stale DI feedback)
            if (state.saunaHeating === 1 && state.saunaOn !== 1) {
                const tickSeconds = effectiveTickMs() / 1000;
                addPreheatDuration(tickSeconds, now);
            }

            publishControlStates();

            state.tickCounter += 1;
            let phaseChanged = false;
            if (state.tickCounter > 3) {
                state.tickCounter = 0;
                state.rhLed = state.rhLed ^ 1;
                phaseChanged = true;
            }

            const { ledValue, changed: ledChanged } = computeLedValue();
            const heatingActive = state.saunaHeating === 1;

            if (phaseChanged) {
                refreshDisplayRows();
                sendDisplay(ledValue);
            } else if (ledChanged || heatingActive) {
                sendDisplay(ledValue);
            }

            applyBaselineStatus();

            savePersistentState();
            handleHeaterOverride();
        }

        function onTick() {
            const nowSec = Math.floor(Date.now() / 1000);
            handleControlTick(nowSec);
        }

        function startTimer() {
            if (tickTimer) clearInterval(tickTimer);
            const interval = effectiveTickMs();
            tickTimer = setInterval(onTick, interval);
        }

        function stopTimer() {
            if (tickTimer) clearInterval(tickTimer);
            tickTimer = null;
        }

        refreshDisplayRows();

        // Recalculate quota from history file on startup
        recalculateQuotaFromHistory();

        startTimer();
        setStatus("waiting for inputs", "grey");

        // ---- INPUT HANDLER ----
        node.on("input", (msg) => {
            if (!msg || typeof msg.topic !== "string") return;
            const topic = msg.topic;
            const { value, ts } = parseMessage(msg);

            // Log all SAKW input topics for debugging (including heater feedback)
            if (
                node.enableLogging &&
                (topic === node.heaterTopic ||
                    topic === node.preheatCalendarTopic ||
                    topic === node.preheatForceTopic ||
                    topic === node.preheatDisableTopic ||
                    topic === node.buttonTopic ||
                    topic === node.visitTopic)
            ) {
                logEvent("log", `Input received: topic=${topic}, value=${value}`);
            }

            if (topic === node.heaterTopic) {
                if (value === null) return;
                const feedback = value > 0 ? 1 : 0;
                // Diagnostic: log every SAKW.1 arrival with gap, until IO-layer loss is resolved
                const nowMs = Date.now();
                const prevArrival = state._sakwLastArrivalMs || null;
                state._sakwLastArrivalMs = nowMs;
                const gapStr = prevArrival !== null ? ` gap=${((nowMs - prevArrival) / 1000).toFixed(1)}s` : " (first)";
                node.warn(`SAKW.1 arrived value=${value}${gapStr}`);
                updateActualHeaterState(feedback, "input");
                if (state.actualHeaterState === 0) {
                    resetOverrideState();
                }
                handleHeaterOverride();
                return;
            }

            if (topic === node.buttonTopic) {
                if (value === null) return;
                if (state.buttonState === null) state.buttonState = value;
                if (value === 0 && state.buttonState === 1) {
                    // Debounce: ignore toggle if another toggle happened within the last 10 seconds.
                    // With sticky-bit DI enabled, every brief press now registers; without debounce,
                    // rapid repeated presses would toggle visit ON/OFF multiple times unintentionally.
                    const VISIT_TOGGLE_DEBOUNCE_SEC = 10;
                    const nowSec = Math.floor(Date.now() / 1000);
                    const lastToggle = state._lastVisitToggleTs || 0;
                    if (nowSec - lastToggle < VISIT_TOGGLE_DEBOUNCE_SEC) {
                        node.warn(`Button debounced: ${nowSec - lastToggle}s < ${VISIT_TOGGLE_DEBOUNCE_SEC}s since last toggle (saunaOn=${state.saunaOn})`);
                        state.buttonState = value;
                        return;
                    }

                    // Button press: stop preheat if active, then toggle visit
                    if (state.saunaOn === 0 && state.saunaHeating === 1 && effectivePreheatAllowed() === 1) {
                        // Preheat is active, stop it
                        setSaunaHeating(0, "off");
                    }
                    // Toggle visit mode
                    const newVisit = state.saunaOn ^ 1;
                    state._lastVisitToggleTs = nowSec;
                    setVisit(newVisit, `Visit toggled to ${newVisit} (button)`);
                }
                state.buttonState = value;
                return;
            }

            if (node.preheatCalendarTopic && topic === node.preheatCalendarTopic) {
                if (value === null) return;
                const allowed = value > 0 ? 1 : 0;
                if (state.preheatAllowed !== allowed) {
                    state.preheatAllowed = allowed;
                    // If calendar tries to activate preheat but quota is full, ignore it
                    if (allowed === 1 && state.preheatQuotaExceeded) {
                        logEvent("warn", "Calendar preheat signal ignored - quota exceeded");
                    } else {
                        node.warn(`SAKW.3 changed: ${allowed} (preheat calendar ${allowed ? "ON" : "OFF"})`);
                    }
                } else {
                    state.preheatAllowed = allowed;
                }
                return;
            }

            if (node.visitNeedTopic && topic === node.visitNeedTopic) {
                if (value === null) return;
                const need = value > 0 ? 1 : 0;
                if (state._visitNeed !== need) {
                    state._visitNeed = need;
                    node.warn(`SAKW.2 changed: ${need} (visiting need ${need ? "active" : "cleared"})`);
                }
                return;
            }

            if (topic === node.preheatForceTopic) {
                if (value === null) return;
                const forced = value > 0 ? 1 : 0;
                if (state.preheatForced !== forced) {
                    state.preheatForced = forced;
                    // If forced OFF is active, clear forced ON and output 0 to reset the command
                    if (state.preheatDisabled && forced) {
                        state.preheatForced = 0;
                        logEvent("warn", "Forced OFF active - ignoring forced ON");
                        // Output 0 to forced ON topic to reset the invalid command (only if input was not already 0)
                        if (node.preheatForceTopic && forced !== 0) {
                            publish(node.preheatForceTopic, 0);
                        }
                    } else {
                        logEvent("log", `Preheat forced signal received: ${forced ? "ON" : "OFF"} (SAKW.4)`);
                    }
                } else {
                    state.preheatForced = forced;
                }
                return;
            }

            if (topic === node.preheatDisableTopic) {
                if (value === null) return;
                const disabled = value > 0 ? 1 : 0;
                if (state.preheatDisabled !== disabled) {
                    state.preheatDisabled = disabled;
                    // If forced OFF becomes active, clear forced ON and cancel visit
                    if (disabled) {
                        if (state.preheatForced) {
                            state.preheatForced = 0;
                            logEvent("warn", "Forced OFF active - clearing forced ON");
                        }
                        // Cancel visit if active
                        if (state.saunaOn === 1) {
                            setVisit(0, "Visit cancelled (forced OFF active)");
                        }
                    }
                    logEvent("log", `Preheat disable ${disabled ? "ON" : "OFF"}`);
                } else {
                    state.preheatDisabled = disabled;
                }
                return;
            }

            if (topic === node.upperTempTopic) {
                if (value === null) return;
                if (state.lowerTemp !== null && value < state.lowerTemp) {
                    logEvent("warn", `Ignoring upper temp ${value} dC below lower temp ${state.lowerTemp} dC`);
                    return;
                }
                state.upperTemp = value;
                state.lastUpperTempInputTs = Math.floor(Date.now() / 1000);
                updateLidState(value, ts);
                // Don't update displayRows here - let tick handle it
                return;
            }

            if (topic === node.lowerTempTopic) {
                if (value === null) return;
                state.lowerTemp = value;
                // Don't update displayRows here - let tick handle it
                return;
            }

            if (topic === node.highLimitTopic) {
                if (value === null) return;
                state.highLimit = value;
                ensureHighLimitBounds();
                return;
            }

            if (topic === node.shellTempTopic) {
                if (value === null) return;
                state.shellTemp = value;
                return;
            }

            if (topic === node.shellMaxTopic) {
                if (value === null) return;
                state.maxShellTemp = value;
                return;
            }

            if (topic === node.humidityTopTopic) {
                if (value === null) return;
                state.humidityTop = value;
                // Don't update displayRows here - let tick handle it
                return;
            }

            if (topic === node.humidityBottomTopic) {
                if (value === null) return;
                state.humidityBottom = value;
                // Don't update displayRows here - let tick handle it
                return;
            }
        });

        node.on("close", (done) => {
            stopTimer();
            resetOverrideState();
            savePersistentState();
            node.status({});
            done();
        });
    }

    RED.nodes.registerType("uniflex-sauna-control", SaunaControlNode);
};
