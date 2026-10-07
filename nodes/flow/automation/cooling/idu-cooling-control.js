const ts = require("../../core/lib/timestamp.js");
// idu-cooling-control.js
// Room IDU cooling enable from CTA/CTB temperature vs setpoint, with window inhibit.
// Outputs CAC/CBC cooling command (1=on, 0=off). Values in degrees C via read/write nodes.

const IDU_COOLING_VERSION = "2.9.0";
const IDU_SETPOINT_SYNC_SEC = 60;
const IDU_OFF_WORD = 159;
const IDU_OFF_RETRY_SEC = 180;
const GDBW_DEADBAND_TOPIC = "GDBW.1";
const GDBW_OFFSET_TOPIC = "GDBW.2";
const GDBW_DEFAULT_DEADBAND_C = 2.0;

// CAC709S.1 -> CAS709W.3 / CAD709V.1
// CBC312W.1 -> CBS312W.3 / CBD312W.1
// CBC312W.2 -> CBS312W.9 / CBD312W.2
function deriveOffRetryTopics(coolCmdTopic) {
    const t = String(coolCmdTopic || "").trim();
    let m = t.match(/^CAC(\d+)S\.(\d+)$/);
    if (m) {
        return {
            casCoolTopic: "CAS" + m[1] + "W.3",
            cadCmdTopic: "CAD" + m[1] + "V." + m[2]
        };
    }
    m = t.match(/^CBC(\d+)W\.(\d+)$/);
    if (m) {
        const cmdMem = Number(m[2]);
        const casMem = cmdMem === 2 ? 9 : 3;
        return {
            casCoolTopic: "CBS" + m[1] + "W." + casMem,
            cadCmdTopic: "CBD" + m[1] + "W." + cmdMem
        };
    }
    return { casCoolTopic: "", cadCmdTopic: "" };
}

module.exports = function (RED) {
    function IduCoolingControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const tag = `[idu-cooling:${node.name || "unnamed"}]`;

        node.name = config.name || "";
        node.enableDebug = config.enableDebug === true;

        node.tempTopic = (config.tempTopic || "").trim();
        node.setpointTopic = (config.setpointTopic || "").trim();
        node.iduSetpointTopic = (config.iduSetpointTopic || "").trim();
        node.windowTopic = (config.windowTopic || "").trim();
        node.ecoTopic = (config.ecoTopic || "").trim();
        node.coolCmdTopic = (config.coolCmdTopic || "").trim();
        node.coolValveTopic = (config.coolValveTopic || "").trim();
        node.demandMode = (config.demandMode || "threshold").trim();
        const derivedOff = deriveOffRetryTopics(node.coolCmdTopic);
        node.casCoolTopic = (config.casCoolTopic || derivedOff.casCoolTopic || "").trim();
        node.cadCmdTopic = (config.cadCmdTopic || derivedOff.cadCmdTopic || "").trim();
        const parsedRetry = Number(config.offRetrySec);
        node.offRetrySec = Number.isFinite(parsedRetry) && parsedRetry > 0
            ? parsedRetry
            : IDU_OFF_RETRY_SEC;

        node.localHysteresisC = Math.max(0, Number(config.hysteresisC ?? 0.3));
        node.windowOpenValue = Number(config.windowOpenValue ?? 1);
        // Fallback only; the live ECO-active value comes from the shared cooling config.
        node.localEcoActiveValue = Number(config.ecoActiveValue ?? 1);

        let gdbwDeadbandC = GDBW_DEFAULT_DEADBAND_C;
        let gdbwOffsetC = 0;

        const sharedConfig = config.coolingConfig ? RED.nodes.getNode(config.coolingConfig) : null;
        node.coolingConfig = sharedConfig;
        let unregisterGlobalListener = null;
        let iduSetpointSyncTimer = null;
        let offRetryTimer = null;
        let startupSetpointTimer = null;
        let casCoolOn = false;
        let wantOffSinceMs = 0;
        let lastForceOffMs = 0;

        function getGlobalEnableTopic() {
            if (sharedConfig && sharedConfig.globalEnableTopic) {
                return String(sharedConfig.globalEnableTopic).trim();
            }
            return "";
        }

        function isCoolingGloballyEnabled() {
            if (sharedConfig && typeof sharedConfig.coolingEnabled === "boolean") {
                return sharedConfig.coolingEnabled;
            }
            return true;
        }

        function isCoolingOpsReady() {
            const globalTopic = getGlobalEnableTopic();
            if (!globalTopic) return true;
            if (sharedConfig && sharedConfig.globalEnableKnown === false) return false;
            return true;
        }

        function applyGlobalEnable(payload, source) {
            if (sharedConfig && typeof sharedConfig.applyGlobalDisable === "function") {
                sharedConfig.applyGlobalDisable(payload, source || "global");
            }
        }

        function onGlobalCoolingChange() {
            computeAndPublish();
        }

        if (sharedConfig && typeof sharedConfig.registerIduListener === "function") {
            unregisterGlobalListener = sharedConfig.registerIduListener(onGlobalCoolingChange);
        }

        function getIduOffsetC() {
            return gdbwOffsetC;
        }

        function getDeadbandC() {
            return Math.max(0, gdbwDeadbandC == null ? GDBW_DEFAULT_DEADBAND_C : gdbwDeadbandC);
        }

        function getHysteresisC() {
            if (sharedConfig && Number.isFinite(sharedConfig.hysteresisC)) {
                return Math.max(0, sharedConfig.hysteresisC);
            }
            return node.localHysteresisC;
        }

        // ECO inhibit polarity is global (cooling config), not per IDU node.
        function getEcoActiveValue() {
            if (sharedConfig && Number.isFinite(sharedConfig.ecoActiveValue)) {
                return sharedConfig.ecoActiveValue;
            }
            return node.localEcoActiveValue;
        }

        function isEcoInhibited() {
            if (!node.ecoTopic) return false;
            return ecoActive !== false;
        }

        let tempC = null;
        let setpointC = null;
        let windowOpen = node.windowTopic ? null : false;
        let ecoActive = node.ecoTopic ? null : false;
        let coolValveDemand = node.demandMode === "valve" && node.coolValveTopic ? null : 0;
        let coolingActive = false;
        let lastIduSetpointC = null;
        const lastSent = {};

        function isValveDemandMode() {
            return node.demandMode === "valve";
        }

        function dbg(msg) {
            if (node.enableDebug) node.log(`${tag} ${msg}`);
        }

        function fmtC(n, digits) {
            return Number.isFinite(n) ? n.toFixed(digits) : "?";
        }

        function isActiveFlag(payload, activeValue) {
            if (payload == null) return null;
            const n = Number(payload);
            if (!Number.isFinite(n)) return null;
            return n >= activeValue;
        }

        function isWindowOpen(payload) {
            return isActiveFlag(payload, node.windowOpenValue);
        }

        function isEcoActive(payload) {
            // E display: 1 = ECO active (inhibit cooling), 0 = comfort.
            if (payload == null) return null;
            const n = Number(payload);
            if (!Number.isFinite(n)) return null;
            return n === getEcoActiveValue();
        }

        function isWindowInhibited() {
            if (!node.windowTopic) return false;
            return windowOpen !== false;
        }

        function blockReason() {
            const parts = [];
            if (!isCoolingGloballyEnabled()) parts.push("CGOLS disable");
            if (isWindowInhibited()) {
                parts.push(windowOpen == null ? "window unknown" : "window open");
            }
            if (!isValveDemandMode() && isEcoInhibited()) {
                parts.push(ecoActive == null ? "ECO unknown" : "ECO active");
            }
            return parts.join(", ");
        }

        // Symmetric hysteresis around centreC (= setpoint + deadband):
        // turn ON above centre + hyst, turn OFF below centre - hyst.
        function applyHysteresis(currentC, active, centreC) {
            const hyst = getHysteresisC();
            if (active) {
                return currentC > centreC - hyst;
            }
            return currentC > centreC + hyst;
        }

        function sendCoolCmd(payload, reason) {
            if (!isCoolingOpsReady()) return;
            const topic = node.coolCmdTopic;
            if (!topic) return;
            if (lastSent[topic] === payload) return;
            lastSent[topic] = payload;
            if (node.enableDebug) {
                const parts = [`${topic}=${payload}`];
                if (isValveDemandMode() && node.coolValveTopic) {
                    parts.push(`${node.coolValveTopic}=${coolValveDemand}`);
                }
                if (Number.isFinite(tempC)) {
                    parts.push(`T=${tempC.toFixed(1)}`);
                }
                if (Number.isFinite(setpointC)) {
                    parts.push(`sp=${setpointC.toFixed(1)}`);
                }
                if (windowOpen) {
                    parts.push("win=1");
                }
                if (!isValveDemandMode() && ecoActive) {
                    parts.push("eco=1");
                }
                if (!isCoolingGloballyEnabled()) {
                    parts.push("CGOLS=0");
                }
                node.log(`${tag} cooling cmd ${parts.join(" ")} (${reason})`);
            }
            node.send({ topic, payload });
        }

        function sendForceOff(reason) {
            if (!node.cadCmdTopic) return;
            lastForceOffMs = Date.now();
            node.log(
                `${tag} force IDU off ${node.cadCmdTopic}=${IDU_OFF_WORD} ` +
                    `(${reason} cas=${node.casCoolTopic || "none"}=1)`
            );
            node.send({
                topic: node.cadCmdTopic,
                payload: IDU_OFF_WORD,
                forced: true
            });
        }

        function offRetryMs() {
            return Math.max(50, node.offRetrySec * 1000);
        }

        function maybeForceOff(reason) {
            if (coolingActive || casCoolOn !== true || !node.cadCmdTopic) {
                return;
            }
            const now = Date.now();
            if (!wantOffSinceMs) {
                wantOffSinceMs = now;
            }
            const retryMs = offRetryMs();
            if (now - wantOffSinceMs < retryMs) {
                return;
            }
            if (lastForceOffMs && now - lastForceOffMs < retryMs) {
                return;
            }
            sendForceOff(reason);
        }

        function startOffRetryTimer() {
            if (offRetryTimer || !node.casCoolTopic || !node.cadCmdTopic) {
                return;
            }
            offRetryTimer = setInterval(() => {
                maybeForceOff("retry-timer");
            }, offRetryMs());
        }

        function stopOffRetryTimer() {
            if (offRetryTimer) {
                clearInterval(offRetryTimer);
                offRetryTimer = null;
            }
        }

        function sendIduSetpoint(thermSpC, force) {
            if (!isCoolingOpsReady()) return;
            if (!coolingActive) return;
            if (gdbwDeadbandC == null || gdbwOffsetC == null) return;
            const topic = node.iduSetpointTopic;
            if (!topic || !Number.isFinite(thermSpC)) return;
            const deadband = getDeadbandC();
            const offset = getIduOffsetC();
            const iduSpC = parseFloat((thermSpC + deadband + offset).toFixed(2));
            if (!force && lastIduSetpointC === iduSpC) return;
            lastIduSetpointC = iduSpC;
            if (node.enableDebug) {
                node.log(`${tag} IDU setpoint ${topic} -> ${iduSpC.toFixed(2)}C ` + `(r513 ${thermSpC.toFixed(2)}C + db ${deadband.toFixed(2)}C + offs ${offset.toFixed(2)}C)`);
            }
            node.send({ topic, payload: iduSpC });
        }

        function publishIduSetpointIfNeeded(reason, force) {
            if (!Number.isFinite(setpointC)) return;
            sendIduSetpoint(setpointC, force === true);
            dbg(`IDU setpoint sync (${reason})`);
        }

        function startIduSetpointSyncTimer() {
            if (iduSetpointSyncTimer || IDU_SETPOINT_SYNC_SEC <= 0) return;
            iduSetpointSyncTimer = setInterval(() => {
                publishIduSetpointIfNeeded("periodic", true);
            }, IDU_SETPOINT_SYNC_SEC * 1000);
        }

        function stopIduSetpointSyncTimer() {
            if (iduSetpointSyncTimer) {
                clearInterval(iduSetpointSyncTimer);
                iduSetpointSyncTimer = null;
            }
        }

        function updateStatus(blocked) {
            if (!isValveDemandMode() && (tempC == null || setpointC == null)) {
                node.status({
                    fill: "grey",
                    shape: "ring",
                    text: "waiting for temp/setpoint"
                });
                return;
            }
            if (isValveDemandMode() && tempC == null && setpointC == null) {
                node.status({
                    fill: "grey",
                    shape: "ring",
                    text: "waiting for inputs"
                });
                return;
            }
            if (!isCoolingOpsReady()) {
                node.status({
                    fill: "grey",
                    shape: "ring",
                    text: "waiting for CGOLS"
                });
                return;
            }
            const err = tempC != null && setpointC != null ? tempC - setpointC : 0;
            let fill = "blue";
            if (blocked) fill = "yellow";
            else if (coolingActive) fill = "blue";
            const winTxt = windowOpen == null ? " win=?" : windowOpen ? " win=OPEN" : "";
            const ecoTxt = !isValveDemandMode() && isEcoInhibited() ? " eco=1" : "";
            const globalTxt = !isCoolingGloballyEnabled() ? " CGOLS=1" : "";
            const valveTxt = isValveDemandMode() ? ` v=${coolValveDemand}` : "";
            const iduTxt = lastIduSetpointC != null ? ` idu=${lastIduSetpointC.toFixed(1)}` : "";
            const tempTxt = tempC != null ? `${tempC.toFixed(1)}C` : "?C";
            const spTxt = setpointC != null ? `${setpointC.toFixed(1)}C` : "?C";
            const errTxt = tempC != null && setpointC != null ? ` d=${err >= 0 ? "+" : ""}${err.toFixed(1)}` : "";
            node.status({
                fill,
                shape: "dot",
                text: `${tempTxt} sp=${spTxt}${iduTxt}${errTxt} cool=${coolingActive ? 1 : 0}${valveTxt}${globalTxt}${winTxt}${ecoTxt}`
            });
        }

        function failSafeOff(reason) {
            const prev = coolingActive;
            coolingActive = false;
            if (prev) {
                wantOffSinceMs = Date.now();
                node.log(`${tag} cooling OFF ${node.coolCmdTopic || "?"}: ${reason}`);
            }
            sendCoolCmd(0, "OFF");
            maybeForceOff(reason);
            updateStatus(true);
        }

        function computeAndPublish() {
            if (!isCoolingOpsReady()) {
                failSafeOff("CGOLS unknown");
                return;
            }
            if (!isValveDemandMode() && (tempC == null || setpointC == null)) {
                failSafeOff("unknown temp/sp");
                return;
            }
            if (isValveDemandMode() && node.coolValveTopic && coolValveDemand == null) {
                failSafeOff("unknown valve");
                return;
            }
            if (isValveDemandMode() && tempC == null && setpointC == null && !node.coolValveTopic) {
                failSafeOff("unknown inputs");
                return;
            }

            const blocked = !isCoolingGloballyEnabled() || isWindowInhibited() || (!isValveDemandMode() && isEcoInhibited());

            let wantCool;
            let onThresholdC = null;
            let offThresholdC = null;
            if (isValveDemandMode()) {
                wantCool = coolValveDemand === 1 && !blocked;
            } else {
                // Enable uses thermokon SP + half deadband (setpoint write adds full deadband to IDU).
                const halfDb = getDeadbandC() / 2;
                const centreC = setpointC + halfDb;
                onThresholdC = centreC + getHysteresisC();
                offThresholdC = centreC - getHysteresisC();
                wantCool = applyHysteresis(tempC, coolingActive, centreC);
                if (blocked) {
                    wantCool = false;
                }
            }

            const prev = coolingActive;
            coolingActive = wantCool;

            if (coolingActive && !prev) {
                wantOffSinceMs = 0;
                lastForceOffMs = 0;
                publishIduSetpointIfNeeded("cool-on", true);
            } else if (!coolingActive && prev) {
                wantOffSinceMs = Date.now();
            }

            if (coolingActive !== prev) {
                const cmd = node.coolCmdTopic || "?";
                if (coolingActive) {
                    if (isValveDemandMode()) {
                        const spTxt = Number.isFinite(setpointC) ? `(sp ${setpointC.toFixed(1)}C)` : "(sp pending)";
                        node.log(`${tag} cooling ON ${cmd}: thermokon cool valve=1 ${spTxt}`);
                    } else {
                        node.log(`${tag} cooling ON ${cmd}: room ${tempC.toFixed(1)}C above ` + `enable ${onThresholdC.toFixed(1)}C (sp ${setpointC.toFixed(1)}C)`);
                    }
                } else {
                    let why;
                    if (isValveDemandMode()) {
                        why = blocked ? blockReason() : "thermokon cool valve=0";
                    } else {
                        why = blocked ? blockReason() : `room ${tempC.toFixed(1)}C below ${offThresholdC.toFixed(1)}C`;
                    }
                    node.log(`${tag} cooling OFF ${cmd}: ${why}`);
                }
            }

            if (isValveDemandMode()) {
                dbg(`T=${fmtC(tempC, 2)} setpoint=${fmtC(setpointC, 2)} ` + `valve=${coolValveDemand} window=${windowOpen == null ? "?" : windowOpen ? 1 : 0} cool=${coolingActive ? 1 : 0}`);
            } else {
                const halfDb = getDeadbandC() / 2;
                const centreC = setpointC + halfDb;
                dbg(
                    `T=${tempC.toFixed(2)} setpoint=${setpointC.toFixed(2)} centre=${centreC.toFixed(2)} ` +
                        `onAt=${(centreC + getHysteresisC()).toFixed(2)} ` +
                        `offAt=${(centreC - getHysteresisC()).toFixed(2)} ` +
                        `window=${windowOpen == null ? "?" : windowOpen ? 1 : 0} eco=${ecoActive == null ? "?" : ecoActive ? 1 : 0} cool=${coolingActive ? 1 : 0}`
                );
            }

            sendCoolCmd(coolingActive ? 1 : 0, coolingActive ? "ON" : "OFF");
            if (!coolingActive) {
                maybeForceOff("cool-off");
            }
            updateStatus(blocked);
        }

        function applyGdbwDeadband(payload) {
            const n = (payload == null ? null : (Number.isFinite(Number(payload)) ? Number(payload) : null));
            if (n === null) {
                gdbwDeadbandC = null;
                return;
            }
            // read-data-streams already divides GDBW raw dC by conv_coef 10.
            const dbC = Math.max(0, n);
            if (gdbwDeadbandC === dbC) {
                return;
            }
            gdbwDeadbandC = dbC;
            if (node.enableDebug) {
                node.log(`${tag} GDBW.1 deadband ${dbC.toFixed(1)}C`);
            }
            publishIduSetpointIfNeeded("GDBW.1");
            computeAndPublish();
        }

        function applyGdbwOffset(payload) {
            const n = (payload == null ? null : (Number.isFinite(Number(payload)) ? Number(payload) : null));
            if (n === null) {
                gdbwOffsetC = null;
                return;
            }
            const offC = n;
            if (gdbwOffsetC === offC) {
                return;
            }
            gdbwOffsetC = offC;
            if (node.enableDebug) {
                node.log(`${tag} GDBW.2 offset ${offC.toFixed(1)}C`);
            }
            publishIduSetpointIfNeeded("GDBW.2");
            computeAndPublish();
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            const globalTopic = getGlobalEnableTopic();

            if (t === GDBW_DEADBAND_TOPIC) {
                applyGdbwDeadband(msg.payload);
                return;
            }
            if (t === GDBW_OFFSET_TOPIC) {
                applyGdbwOffset(msg.payload);
                return;
            }

            if (globalTopic && t === globalTopic) {
                applyGlobalEnable(msg.payload, globalTopic);
                return;
            }

            if (t === node.tempTopic) {
                tempC = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                computeAndPublish();
                return;
            }

            if (t === node.setpointTopic) {
                setpointC = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                publishIduSetpointIfNeeded("therm-sp");
                computeAndPublish();
                return;
            }

            if (node.windowTopic && t === node.windowTopic) {
                const open = isWindowOpen(msg.payload);
                if (open !== windowOpen) {
                    windowOpen = open;
                    if (isCoolingOpsReady()) {
                        if (windowOpen == null) {
                            node.log(`${tag} window unknown (${node.windowTopic}): cooling inhibited`);
                        } else if (windowOpen) {
                            node.log(`${tag} window OPEN (${node.windowTopic}): cooling inhibited`);
                        } else {
                            node.log(`${tag} window closed (${node.windowTopic}): cooling allowed`);
                        }
                    }
                }
                computeAndPublish();
                return;
            }

            if (!isValveDemandMode() && node.ecoTopic && t === node.ecoTopic) {
                const active = isEcoActive(msg.payload);
                if (active !== ecoActive) {
                    ecoActive = active;
                    if (isCoolingOpsReady()) {
                        if (ecoActive == null) {
                            node.log(`${tag} ECO unknown (${node.ecoTopic}): cooling inhibited`);
                        } else if (ecoActive) {
                            node.log(`${tag} ECO active (${node.ecoTopic}): cooling inhibited`);
                        } else {
                            node.log(`${tag} ECO off (${node.ecoTopic}): cooling allowed`);
                        }
                    }
                }
                computeAndPublish();
                return;
            }

            if (isValveDemandMode() && node.coolValveTopic && t === node.coolValveTopic) {
                const n = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                const demand = n === null ? null : n >= 1 ? 1 : 0;
                if (demand !== coolValveDemand) {
                    coolValveDemand = demand;
                    if (node.enableDebug) {
                        node.log(`${tag} cool valve ${node.coolValveTopic} -> ${demand == null ? "?" : demand}`);
                    }
                }
                computeAndPublish();
                return;
            }

            if (node.casCoolTopic && t === node.casCoolTopic) {
                const n = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                casCoolOn = n === null ? null : n >= 1;
                if (casCoolOn !== true) {
                    lastForceOffMs = 0;
                }
                maybeForceOff("cas-cool");
            }
        });

        const thresholdSource = sharedConfig ? `shared:${sharedConfig.name}` : "local";
        const modeTxt = isValveDemandMode() ? "valve" : "threshold";
        node.log(
            `${tag} started v${IDU_COOLING_VERSION} mode=${modeTxt} thresholds=${thresholdSource} ` +
                `global=${getGlobalEnableTopic() || "none"} ` +
                `db=${getDeadbandC().toFixed(1)}C iduOffs=${getIduOffsetC().toFixed(1)}C ` +
                `hysteresis=+-${getHysteresisC().toFixed(1)}C ` +
                `valve=${node.coolValveTopic || "none"} ` +
                `cas=${node.casCoolTopic || "none"} cad=${node.cadCmdTopic || "none"} ` +
                `offRetry=${node.offRetrySec}s`
        );
        updateStatus(false);
        startIduSetpointSyncTimer();
        startOffRetryTimer();
        startupSetpointTimer = setTimeout(() => {
            startupSetpointTimer = null;
            publishIduSetpointIfNeeded("startup", true);
        }, 5000);

        node.on("close", () => {
            stopIduSetpointSyncTimer();
            stopOffRetryTimer();
            if (startupSetpointTimer) {
                clearTimeout(startupSetpointTimer);
                startupSetpointTimer = null;
            }
            if (unregisterGlobalListener) {
                unregisterGlobalListener();
            }
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-idu-cooling-control", IduCoolingControlNode);
};

module.exports.deriveOffRetryTopics = deriveOffRetryTopics;
