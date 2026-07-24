const ts = require("../../core/lib/timestamp.js");
// idu-cooling-control.js
// Room IDU cooling enable from CTA/CTB temperature vs setpoint, with window inhibit.
// Outputs CAC/CBC cooling command (1=on, 0=off). Values in degrees C via read/write nodes.

const IDU_COOLING_VERSION = "2.7.1";
const IDU_SETPOINT_SYNC_SEC = 60;
const GDBW_DEADBAND_TOPIC = "GDBW.1";
const GDBW_OFFSET_TOPIC = "GDBW.2";
const GDBW_DEFAULT_DEADBAND_C = 2.0;

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
            return Math.max(0, gdbwDeadbandC);
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
            return ecoActive;
        }

        let tempC = null;
        let setpointC = null;
        let windowOpen = false;
        let ecoActive = false;
        let coolValveDemand = 0;
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
            if (payload == null || payload === "") return false;
            const n = Number(payload);
            if (Number.isFinite(n)) return n >= activeValue;
            return !!payload;
        }

        function isWindowOpen(payload) {
            return isActiveFlag(payload, node.windowOpenValue);
        }

        function isEcoActive(payload) {
            // E display: 1 = ECO active (inhibit cooling), 0 = comfort.
            if (payload == null || payload === "") return false;
            const n = Number(payload);
            if (!Number.isFinite(n)) return !!payload;
            return n === getEcoActiveValue();
        }

        function blockReason() {
            const parts = [];
            if (!isCoolingGloballyEnabled()) parts.push("CGOLS disable");
            if (windowOpen) parts.push("window open");
            if (!isValveDemandMode() && isEcoInhibited()) parts.push("ECO active");
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
            dbg(`${topic} -> ${payload} (${reason})`);
            node.send({ topic, payload });
        }

        function sendIduSetpoint(thermSpC, force) {
            if (!isCoolingOpsReady()) return;
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
            const winTxt = windowOpen ? " win=OPEN" : "";
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

        function computeAndPublish() {
            if (!isCoolingOpsReady()) {
                updateStatus(false);
                return;
            }
            if (!isValveDemandMode() && (tempC == null || setpointC == null)) {
                updateStatus(false);
                return;
            }
            if (isValveDemandMode() && tempC == null && setpointC == null && !node.coolValveTopic) {
                updateStatus(false);
                return;
            }

            const blocked = !isCoolingGloballyEnabled() || windowOpen || (!isValveDemandMode() && isEcoInhibited());

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
                dbg(`T=${fmtC(tempC, 2)} setpoint=${fmtC(setpointC, 2)} ` + `valve=${coolValveDemand} window=${windowOpen ? 1 : 0} cool=${coolingActive ? 1 : 0}`);
            } else {
                const halfDb = getDeadbandC() / 2;
                const centreC = setpointC + halfDb;
                dbg(
                    `T=${tempC.toFixed(2)} setpoint=${setpointC.toFixed(2)} centre=${centreC.toFixed(2)} ` +
                        `onAt=${(centreC + getHysteresisC()).toFixed(2)} ` +
                        `offAt=${(centreC - getHysteresisC()).toFixed(2)} ` +
                        `window=${windowOpen ? 1 : 0} eco=${ecoActive ? 1 : 0} cool=${coolingActive ? 1 : 0}`
                );
            }

            sendCoolCmd(coolingActive ? 1 : 0, coolingActive ? "ON" : "OFF");
            updateStatus(blocked);
        }

        function applyGdbwDeadband(payload) {
            const n = Number(payload);
            if (!Number.isFinite(n)) {
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
            const n = Number(payload);
            if (!Number.isFinite(n)) {
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
                const n = Number(msg.payload);
                if (!Number.isFinite(n)) return;
                tempC = n;
                computeAndPublish();
                return;
            }

            if (t === node.setpointTopic) {
                const n = Number(msg.payload);
                if (!Number.isFinite(n)) return;
                setpointC = n;
                publishIduSetpointIfNeeded("therm-sp");
                computeAndPublish();
                return;
            }

            if (node.windowTopic && t === node.windowTopic) {
                const open = isWindowOpen(msg.payload);
                if (open !== windowOpen) {
                    windowOpen = open;
                    if (isCoolingOpsReady()) {
                        if (windowOpen) {
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
                        if (ecoActive) {
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
                const n = Number(msg.payload);
                const demand = Number.isFinite(n) && n >= 1 ? 1 : 0;
                if (demand !== coolValveDemand) {
                    coolValveDemand = demand;
                    if (node.enableDebug) {
                        node.log(`${tag} cool valve ${node.coolValveTopic} -> ${demand}`);
                    }
                }
                computeAndPublish();
            }
        });

        const thresholdSource = sharedConfig ? `shared:${sharedConfig.name}` : "local";
        const modeTxt = isValveDemandMode() ? "valve" : "threshold";
        node.log(
            `${tag} started v${IDU_COOLING_VERSION} mode=${modeTxt} thresholds=${thresholdSource} ` +
                `global=${getGlobalEnableTopic() || "none"} ` +
                `db=${getDeadbandC().toFixed(1)}C iduOffs=${getIduOffsetC().toFixed(1)}C ` +
                `hysteresis=+-${getHysteresisC().toFixed(1)}C ` +
                `valve=${node.coolValveTopic || "none"}`
        );
        updateStatus(false);
        startIduSetpointSyncTimer();
        setTimeout(() => publishIduSetpointIfNeeded("startup", true), 5000);

        node.on("close", () => {
            stopIduSetpointSyncTimer();
            if (unregisterGlobalListener) {
                unregisterGlobalListener();
            }
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-idu-cooling-control", IduCoolingControlNode);
};
