const ts = require("../../core/lib/timestamp.js");

const THERMOKON_FLAT_VERSION = "2.3.2";
const INPUT_STATE_UID_FALLBACK = "local";
const R514_ECO = 18;
const R514_COMFORT = 2;
const COMFORT_PULSE_SEC = 90;
// Min gap between non-cooled panel-sync r514 writes.
const PANEL_SYNC_MIN_MS = 5000;
// Re-check E display and P corrective against known M r277.
const DISPLAY_RESYNC_MS = 60000;
// Coalesce per-member M r277 msgs (MBN201W.1/.2/.3) before E display update.
const MODE_BATCH_MS = 20;

function buildPreset(flatType, flat) {
    const f = String(flat || "").trim();
    if (!f) {
        return null;
    }
    if (flatType === "non-cooled-1") {
        return {
            forceTopic: `P1N${f}S.1`,
            modeTopics: [`MAN${f}W.1`, `MAN${f}W.2`],
            writeTopics: [`WAN${f}W.1`, `WAN${f}W.2`],
            displayTopics: [`E1N${f}W.1`, `E1N${f}W.2`],
            sanitaryWriteTopic: "",
            comfortPulseTopic: "",
            valveTopics: []
        };
    }
    if (flatType === "non-cooled-2") {
        return {
            forceTopic: `P2N${f}S.1`,
            modeTopics: [`MBN${f}W.1`, `MBN${f}W.2`, `MBN${f}W.3`],
            writeTopics: [`WBN${f}W.1`, `WBN${f}W.2`, `WBN${f}W.3`],
            displayTopics: [`E2N${f}W.1`, `E2N${f}W.2`, `E2N${f}W.3`],
            sanitaryWriteTopic: "",
            comfortPulseTopic: "",
            valveTopics: []
        };
    }
    if (flatType === "cooled-1") {
        if (f === "213") {
            return {
                forceTopic: "",
                modeTopics: [`MCC${f}W.1`],
                writeTopics: [],
                displayTopics: [],
                sanitaryWriteTopic: "",
                sanDisplayTopic: "",
                comfortPulseTopic: `P1C${f}S.1`,
                valveTopics: [],
            };
        }
        return {
            forceTopic: "",
            modeTopics: [`MAC${f}W.1`],
            writeTopics: [],
            displayTopics: [],
            sanitaryWriteTopic: `WAC${f}W.1`,
            sanDisplayTopic: `E0C${f}S.1`,
            comfortPulseTopic: `P1C${f}S.1`,
            valveTopics: [`VAM${f}W.2`, `VAM${f}W.3`],
        };
    }
    if (flatType === "cooled-2") {
        return {
            forceTopic: "",
            modeTopics: [`MBC${f}W.1`],
            writeTopics: [],
            displayTopics: [],
            sanitaryWriteTopic: `WBC${f}W.1`,
            sanDisplayTopic: `E0C${f}S.1`,
            comfortPulseTopic: `P2C${f}S.1`,
            valveTopics: [
                `VBM${f}W.2`,
                `VBM${f}W.3`,
                `VBM${f}W.4`,
                `VBM${f}W.5`
            ],
        };
    }
    const valveTopics = [`VAM${f}W.2`, `VAM${f}W.3`];
    return {
        forceTopic: "",
        modeTopics: [`MAC${f}W.1`],
        writeTopics: [],
        displayTopics: [],
        sanitaryWriteTopic: `WAC${f}W.1`,
        sanDisplayTopic: `E0C${f}S.1`,
        comfortPulseTopic: `P1C${f}S.1`,
        valveTopics,
    };
}

module.exports = function (RED) {
    function ThermokonFlatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const tag = `[thermokon-flat:${node.name || "unnamed"}]`;

        node.name = config.name || "";
        node.enableDebug = config.enableDebug === true;
        node.flatType = config.flatType || "non-cooled-2";
        node.flatNumber = String(config.flatNumber || "").trim();
        const preset = buildPreset(node.flatType, node.flatNumber);
        node.forceTopic = (config.forceTopic || (preset && preset.forceTopic) || "").trim();
        node.writeTopics = parseTopicList(config.writeTopics || (preset && preset.writeTopics.join(",")));
        node.modeTopics = parseTopicList(config.modeTopics || (preset && preset.modeTopics.join(",")));
        node.displayTopics = parseTopicList(config.displayTopics || (preset && preset.displayTopics.join(",")));
        node.comfortPulseTopic = (
            config.comfortPulseTopic || (preset && preset.comfortPulseTopic) || ""
        ).trim();
        node.sanitaryWriteTopic = (
            config.sanitaryWriteTopic || (preset && preset.sanitaryWriteTopic) || ""
        ).trim();
        node.sanDisplayTopic = (
            config.sanDisplayTopic || (preset && preset.sanDisplayTopic) || ""
        ).trim();
        node.valveTopics = parseTopicList(
            config.valveTopics || (preset && preset.valveTopics && preset.valveTopics.join(",")) || ""
        );

        const isNonCooled = node.flatType.startsWith("non-cooled");
        const isCooled = !isNonCooled;
        const zoneCount = isCooled ? node.modeTopics.length : node.displayTopics.length;

        const modeByTopic = {};
        const displayEcoByZone = new Array(zoneCount).fill(null);
        let lastWrittenWord = null;
        let lastPanelSyncMs = 0;
        let lastSanDisplayEco = null;
        const prevModeByTopic = {};
        let pendingPanelSyncZone = null;
        let displayResyncTimer = null;
        let modeBatchTimer = null;
        let comfortPulseTimer = null;
        let nonCooledPulseTimer = null;
        let lastInputUniqueId = "";
        // Full MBN array from the latest streamValues packet (source of truth for E display).
        let lastStreamModes = null;
        const valveByTopic = {};

        function parseTopicList(raw) {
            return String(raw || "")
                .split(/[,;\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
        }

        function parseForce(payload) {
            if (payload == null || payload === "") {
                return null;
            }
            const n = Number(payload);
            if (Number.isFinite(n)) {
                return n >= 1 ? 1 : 0;
            }
            return payload ? 1 : 0;
        }

        function parseValveDemand(payload) {
            if (payload == null || payload === "") {
                return null;
            }
            const n = Number(payload);
            if (!Number.isFinite(n)) {
                return payload ? 1 : 0;
            }
            return n >= 0.5 ? 1 : 0;
        }

        function sanModeTopic() {
            return node.modeTopics[0] || "";
        }

        function isLivingValveReason(reason) {
            return String(reason).indexOf("living-valve") === 0;
        }

        function isFlatVacant() {
            if (!node.flatNumber) {
                return false;
            }
            const inputStates = resolveInputStates(lastInputUniqueId || null);
            const brn = "BRN" + node.flatNumber + "S";
            const st = inputStates && inputStates[brn];
            const values = st && st.values;
            if (!Array.isArray(values) || values.length < 1) {
                return false;
            }
            const raw = values[0];
            return (raw == null ? null : (Number.isFinite(Number(raw)) ? Number(raw) : null)) === 1;
        }

        function maybeForceSanComfortFromValve(valveTopic, reason) {
            if (!isCooled || !node.sanitaryWriteTopic || node.valveTopics.length === 0) {
                return;
            }
            if (node.valveTopics.indexOf(valveTopic) < 0) {
                return;
            }
            if (isFlatVacant()) {
                if (node.enableDebug) {
                    node.warn(tag + " L4 skip vacant san " + node.flatNumber);
                }
                return;
            }
            const sanMt = sanModeTopic();
            if (!sanMt) {
                return;
            }
            if (!(sanMt in modeByTopic)) {
                syncModeFromInputCache(lastInputUniqueId || null, reason || "san-guard");
            }
            if (sanMt in modeByTopic && isComfortMode(modeByTopic[sanMt])) {
                return;
            }
            writeR514(
                R514_COMFORT,
                [node.sanitaryWriteTopic],
                `living-valve (${reason || "?"} ${valveTopic})`
            );
        }

        function onValveInput(topic, payload, source) {
            if (!isCooled || node.valveTopics.indexOf(topic) < 0) {
                return;
            }
            const next = parseValveDemand(payload);
            if (next === null) {
                return;
            }
            const prev = Object.prototype.hasOwnProperty.call(valveByTopic, topic)
                ? valveByTopic[topic]
                : null;
            valveByTopic[topic] = next;
            if (next !== 1 || prev === 1) {
                return;
            }
            if (prev !== 0) {
                return;
            }
            maybeForceSanComfortFromValve(topic, source || topic);
        }

        function isEcoMode(r277) {
            const v = (r277 == null ? null : (Number.isFinite(Number(r277)) ? Number(r277) : null));
            if (v === null) {
                return false;
            }
            return v === 18 || v === 0;
        }

        function isActiveEcoMode(r277) {
            return (r277 == null ? null : (Number.isFinite(Number(r277)) ? Number(r277) : null)) === 18;
        }

        function isComfortMode(r277) {
            return (r277 == null ? null : (Number.isFinite(Number(r277)) ? Number(r277) : null)) === 2;
        }

        function targetWordFromR277(r277) {
            if (!(r277 != null && Number.isFinite(Number(r277)))) {
                return null;
            }
            if (isComfortMode(r277)) {
                return R514_COMFORT;
            }
            if (isEcoMode(r277)) {
                return R514_ECO;
            }
            return null;
        }

        function noteModeTopicChange(topic, newVal, prev) {
            prevModeByTopic[topic] = newVal;
            if (!isNonCooled) {
                return;
            }
            if (prev === undefined || prev === newVal) {
                return;
            }
            const zi = node.modeTopics.indexOf(topic);
            if (zi >= 0) {
                pendingPanelSyncZone = zi;
            }
        }

        function writeTopicsNeedingWord(word) {
            const out = [];
            for (let i = 0; i < node.writeTopics.length; i++) {
                const wt = node.writeTopics[i];
                if (!wt) {
                    continue;
                }
                const mt = node.modeTopics[i];
                if (mt && !(mt in modeByTopic)) {
                    continue;
                }
                if (mt && mt in modeByTopic) {
                    const cur = modeByTopic[mt];
                    if (!(cur != null && Number.isFinite(Number(cur)))) {
                        continue;
                    }
                    // E display: r277 0 or 18 = eco. W write: only skip 18; 0=standby needs r514=18.
                    if (word === R514_ECO && isActiveEcoMode(cur)) {
                        continue;
                    }
                    if (word === R514_COMFORT && isComfortMode(cur)) {
                        continue;
                    }
                }
                out.push(wt);
            }
            return out;
        }

        function enforceNonCooledPanelSync(triggerZoneIdx, reason) {
            if (!isNonCooled || nonCooledPulseTimer || node.writeTopics.length === 0) {
                return;
            }
            const mt = node.modeTopics[triggerZoneIdx];
            if (!mt || !(mt in modeByTopic)) {
                return;
            }
            const word = targetWordFromR277(modeByTopic[mt]);
            if (word === null) {
                return;
            }
            const topics = writeTopicsNeedingWord(word);
            if (topics.length === 0) {
                return;
            }
            const now = Date.now();
            if (now - lastPanelSyncMs < PANEL_SYNC_MIN_MS) {
                if (node.enableDebug) {
                    node.log(`${tag} panel-sync skip rate (${reason})`);
                }
                return;
            }
            lastPanelSyncMs = now;
            writeR514(word, topics, `panel-sync (${reason}) z${triggerZoneIdx} M=${modeSummary()}`);
        }

        function flushPendingPanelSync(reason) {
            if (!isNonCooled || nonCooledPulseTimer || pendingPanelSyncZone === null) {
                pendingPanelSyncZone = null;
                return;
            }
            const zi = pendingPanelSyncZone;
            pendingPanelSyncZone = null;
            enforceNonCooledPanelSync(zi, reason || "mode-batch");
        }


        // Cooled san panel: only trust leaving off(0) or eco(18). Target r277 is unreliable on PIR
        // thermokons; san has a manual panel so non-zero after 0/18 is treated as comfort intent.

        function zoneDisplayEco(zoneIdx) {
            const mt = node.modeTopics[zoneIdx];
            if (!mt || !(mt in modeByTopic)) {
                return null;
            }
            if (!(modeByTopic[mt] != null && Number.isFinite(Number(modeByTopic[mt])))) {
                return null;
            }
            return isEcoMode(modeByTopic[mt]) ? 1 : 0;
        }

        function modeSummary() {
            return node.modeTopics
                .map((mt) => {
                    if (!(mt in modeByTopic) || !(modeByTopic[mt] != null && Number.isFinite(Number(modeByTopic[mt])))) {
                        return "?";
                    }
                    return String(modeByTopic[mt]);
                })
                .join(",");
        }

        function rebuildLastStreamModesFromTopics() {
            if (!allModeTopicsKnown()) {
                lastStreamModes = null;
                return;
            }
            lastStreamModes = node.modeTopics.map((mt) => modeByTopic[mt]);
        }

        function clearDisplayEcoCache() {
            for (let zi = 0; zi < zoneCount; zi++) {
                displayEcoByZone[zi] = null;
            }
        }

        // E display array from one mode vector (streamValues or modeTopics order).
        function ecoArrayFromModeValues(modes) {
            if (!Array.isArray(modes) || modes.length < zoneCount) {
                return null;
            }
            const arr = [];
            let anyKnown = false;
            for (let i = 0; i < zoneCount; i++) {
                const n = (modes[i] == null ? null : (Number.isFinite(Number(modes[i])) ? Number(modes[i]) : null));
                if (n === null) {
                    arr.push(null);
                    continue;
                }
                anyKnown = true;
                arr.push(isEcoMode(n) ? 1 : 0);
            }
            return anyKnown ? arr : null;
        }

        function computeDisplayEcoArray() {
            if (isNonCooled && nonCooledPulseTimer) {
                const arr = [];
                for (let zi = 0; zi < zoneCount; zi++) {
                    arr.push(0);
                }
                return arr;
            }
            if (lastStreamModes) {
                const fromStream = ecoArrayFromModeValues(lastStreamModes);
                if (fromStream) {
                    return fromStream;
                }
            }
            if (!allModeTopicsKnown()) {
                return null;
            }
            const modes = node.modeTopics.map((mt) => modeByTopic[mt]);
            return ecoArrayFromModeValues(modes);
        }

        function stopModeBatchTimer() {
            if (modeBatchTimer) {
                clearTimeout(modeBatchTimer);
                modeBatchTimer = null;
            }
        }

        function flushModeBatch(reason) {
            stopModeBatchTimer();
            if (!lastStreamModes) {
                syncModeFromInputCache(null, reason || "mode-batch");
            }
            if (isNonCooled) {
                publishAll(reason || "mode-batch");
                flushPendingPanelSync(reason || "mode-batch");
            } else {
                writeSanDisplayEco(reason || "mode-batch");
            }
        }

        function scheduleModeBatch(reason) {
            stopModeBatchTimer();
            modeBatchTimer = setTimeout(() => {
                modeBatchTimer = null;
                flushModeBatch(reason);
            }, MODE_BATCH_MS);
        }

        function serviceKeyFromTopic(topic) {
            const t0 = String(topic || "").trim();
            const dot = t0.lastIndexOf(".");
            if (dot <= 0) {
                return t0;
            }
            return t0.slice(0, dot);
        }

        function displayServiceKey() {
            return serviceKeyFromTopic(node.displayTopics[0] || "");
        }

        function modeServiceKey() {
            return serviceKeyFromTopic(node.modeTopics[0] || "");
        }

        function rememberController(msg) {
            const uid = msg && msg.controller && msg.controller.uniqueId;
            if (uid) {
                lastInputUniqueId = uid;
            }
        }

        function resolveInputStates(uniqueId) {
            const g = node.context().global;
            const uids = [];
            if (uniqueId) {
                uids.push(uniqueId);
            }
            if (lastInputUniqueId && uids.indexOf(lastInputUniqueId) < 0) {
                uids.push(lastInputUniqueId);
            }
            if (INPUT_STATE_UID_FALLBACK && uids.indexOf(INPUT_STATE_UID_FALLBACK) < 0) {
                uids.push(INPUT_STATE_UID_FALLBACK);
            }
            for (let i = 0; i < uids.length; i++) {
                const st = g.get(`${uids[i]}_input_states`);
                if (st) {
                    return st;
                }
            }
            return null;
        }

        function applyModeValues(modes, reason) {
            if (!Array.isArray(modes) || modes.length === 0) {
                return false;
            }
            let any = false;
            for (let i = 0; i < node.modeTopics.length && i < modes.length; i++) {
                const mt = node.modeTopics[i];
                const n = (modes[i] == null ? null : (Number.isFinite(Number(modes[i])) ? Number(modes[i]) : null));
                if (n === null) {
                    if (mt in modeByTopic) {
                        delete modeByTopic[mt];
                        any = true;
                    }
                    continue;
                }
                const prev = modeByTopic[mt];
                if (modeByTopic[mt] !== n) {
                    modeByTopic[mt] = n;
                    noteModeTopicChange(mt, n, prev);
                    any = true;
                } else {
                    prevModeByTopic[mt] = n;
                }
            }
            if (modes.length >= node.modeTopics.length) {
                lastStreamModes = modes.slice(0, node.modeTopics.length).map((v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null)));
            }
            if (any) {
                clearDisplayEcoCache();
                node.warn(`${tag} M sync (${reason || "?"}) ${modeServiceKey()}=${modeSummary()}`);
            }
            return any;
        }

        // Fill only missing modeTopics from UDP input_states cache. Do not overwrite members
        // already updated by read-data-streams (cache can lag member 1 on some hosts).
        function syncModeFromInputCache(uniqueId, reason) {
            const svcKey = modeServiceKey();
            if (!svcKey || node.modeTopics.length === 0) {
                return false;
            }
            const inputStates = resolveInputStates(uniqueId);
            const values = inputStates && inputStates[svcKey] && inputStates[svcKey].values;
            if (!Array.isArray(values) || values.length === 0) {
                return false;
            }
            let any = false;
            for (let i = 0; i < node.modeTopics.length && i < values.length; i++) {
                const mt = node.modeTopics[i];
                if (mt in modeByTopic) {
                    continue;
                }
                const raw = values[i];
                const n = (raw == null ? null : (Number.isFinite(Number(raw)) ? Number(raw) : null));
                if (n === null) {
                    continue;
                }
                modeByTopic[mt] = n;
                any = true;
            }
            if (any) {
                node.warn(`${tag} M cache fill (${reason || "?"}) ${svcKey}=${modeSummary()}`);
            }
            return any;
        }

        function applyModeArrayPayload(arr, reason) {
            return applyModeValues(arr, reason || "array");
        }

        function allModeTopicsKnown() {
            for (let i = 0; i < node.modeTopics.length; i++) {
                const mt = node.modeTopics[i];
                if (mt && !(mt in modeByTopic)) {
                    return false;
                }
            }
            return node.modeTopics.length > 0;
        }

        function stopDisplayResyncTimer() {
            if (displayResyncTimer) {
                clearInterval(displayResyncTimer);
                displayResyncTimer = null;
            }
        }

        function startDisplayResyncTimer() {
            stopDisplayResyncTimer();
            displayResyncTimer = setInterval(() => {
                syncModeFromInputCache(null, "resync");
                let anyKnown = false;
                for (let zi = 0; zi < zoneCount; zi++) {
                    const mt = node.modeTopics[zi];
                    if (mt && mt in modeByTopic) {
                        anyKnown = true;
                        break;
                    }
                }
                if (anyKnown && isNonCooled) {
                    // Re-push all E zones with known M (retries failed setup writes).
                    writeDisplayEco("resync");
                } else if (isCooled) {
                    syncModeFromInputCache(null, "resync");
                    writeSanDisplayEco("resync");
                }
            }, DISPLAY_RESYNC_MS);
        }

        function sendOut(messages) {
            if (!messages || messages.length === 0) {
                return;
            }
            node.send(messages);
        }

        function fanOutKv(topics, word) {
            if (!topics || topics.length === 0) {
                return "";
            }
            return topics.map((t) => `${t}=${word}`).join(" ");
        }

        function logFanOut(action, reason, kvLine) {
            if (!kvLine) {
                return;
            }
            node.warn(`${tag} fan-out ${action} (${reason}) ${kvLine}`);
        }

        function sendTopicPayloads(entries) {
            if (!entries || entries.length === 0) {
                return;
            }
            if (entries.length === 1) {
                node.send({ topic: entries[0].topic, payload: entries[0].payload });
                return;
            }
            const msg = {};
            entries.forEach((entry) => {
                msg[entry.topic] = entry.payload;
            });
            node.send(msg);
        }

        function sendR514ToWriteNode(word, topics) {
            if (!topics || topics.length === 0) {
                return;
            }
            if (topics.length === 1) {
                node.send({ topic: topics[0], payload: word });
                return;
            }
            // One comprehensive msg so write-data-streams batches all members
            // into a single /setup frame (separate topic msgs can lose MBA 21/41).
            const msg = {};
            topics.forEach((topic) => {
                msg[topic] = word;
            });
            node.send(msg);
        }

        function isPanelSyncReason(reason) {
            return String(reason).indexOf("panel-sync") === 0;
        }

        function writeR514(word, topics, reason) {
            if (!topics || topics.length === 0) {
                return;
            }
            const forceChange = reason === "force-change" || reason === "comfort-pulse" ||
                isPanelSyncReason(reason) || isLivingValveReason(reason);
            if (!forceChange && lastWrittenWord === word) {
                return;
            }
            lastWrittenWord = word;
            sendR514ToWriteNode(word, topics);
            let action = "W-r514";
            if (isPanelSyncReason(reason)) {
                action = "panel-sync";
            } else if (reason === "comfort-pulse") {
                action = "comfort-pulse";
            } else if (isLivingValveReason(reason)) {
                action = "san-comfort";
            }
            logFanOut(action, reason, fanOutKv(topics, word));
        }

        function writeDisplayEco(reason) {
            const reasonStr = String(reason || "");
            const forcePush =
                reasonStr === "resync" ||
                reasonStr === "force-change" ||
                reasonStr === "mode-batch" ||
                reasonStr.indexOf("force") >= 0 ||
                reasonStr === "comfort-pulse" ||
                reasonStr.indexOf("comfort-pulse") >= 0;
            const svcKey = displayServiceKey();
            const fullArr = computeDisplayEcoArray();

            if (fullArr && svcKey && zoneCount > 1) {
                let anyChange = forcePush;
                if (!anyChange) {
                    for (let zi = 0; zi < zoneCount; zi++) {
                        if (displayEcoByZone[zi] !== fullArr[zi]) {
                            anyChange = true;
                            break;
                        }
                    }
                }
                if (!anyChange) {
                    return;
                }
                for (let zi = 0; zi < zoneCount; zi++) {
                    displayEcoByZone[zi] = fullArr[zi];
                }
                node.send({ topic: svcKey, payload: fullArr });
                node.warn(`${tag} E display (${reason}) -> ${svcKey}=[${fullArr.join(",")}] M=${modeSummary()}`);
                return;
            }

            if (!lastStreamModes) {
                syncModeFromInputCache(null, reason);
            }

            let anyChange = false;
            for (let zi = 0; zi < zoneCount; zi++) {
                const eco = zoneDisplayEco(zi);
                if (eco === null) {
                    continue;
                }
                if (forcePush || displayEcoByZone[zi] !== eco) {
                    anyChange = true;
                    break;
                }
            }
            if (!anyChange) {
                return;
            }

            const out = [];
            for (let zi = 0; zi < zoneCount; zi++) {
                const eco = zoneDisplayEco(zi);
                if (eco === null) {
                    continue;
                }
                if (!forcePush && displayEcoByZone[zi] === eco) {
                    continue;
                }
                displayEcoByZone[zi] = eco;
                if (node.displayTopics[zi]) {
                    out.push({ topic: node.displayTopics[zi], payload: eco });
                }
            }
            if (out.length === 0) {
                return;
            }
            sendTopicPayloads(out);
            node.warn(`${tag} E display (${reason}) -> ${out.map((e) => e.topic + "=" + e.payload).join(", ")}` + ` M=${modeSummary()}`);
        }

        function writeSanDisplayEco(reason) {
            if (!isCooled || !node.sanDisplayTopic) {
                return;
            }
            const sanTopic = sanModeTopic();
            if (!sanTopic || !(sanTopic in modeByTopic)) {
                syncModeFromInputCache(lastInputUniqueId || null, reason || "san-display");
            }
            if (!sanTopic || !(sanTopic in modeByTopic)) {
                return;
            }
            const eco = isEcoMode(modeByTopic[sanTopic]) ? 1 : 0;
            const reasonStr = String(reason || "");
            const forcePush = reasonStr === "resync" || reasonStr === "mode-batch" ||
                reasonStr.indexOf("force") >= 0 || reasonStr.indexOf("panel-sync") >= 0;
            if (!forcePush && lastSanDisplayEco === eco) {
                return;
            }
            lastSanDisplayEco = eco;
            node.send({ topic: node.sanDisplayTopic, payload: eco });
            if (node.enableDebug) {
                node.log(`${tag} san display (${reason}) -> ${node.sanDisplayTopic}=${eco}`);
            }
        }

        function publishAll(reason) {
            if (isNonCooled) {
                writeDisplayEco(reason);
            }
            if (isCooled) {
                writeSanDisplayEco(reason);
            }
        }

        function stopNonCooledPulseTimer() {
            if (nonCooledPulseTimer) {
                clearTimeout(nonCooledPulseTimer);
                nonCooledPulseTimer = null;
            }
        }

        function endNonCooledComfortPulse(reason, writeClear) {
            stopNonCooledPulseTimer();
            if (writeClear !== false && node.forceTopic) {
                node.send({ topic: node.forceTopic, payload: 0 });
                logFanOut("P-clear", reason || "comfort-pulse-end", `${node.forceTopic}=0`);
            }
            publishAll(reason || "comfort-pulse-end");
            updateStatus();
        }

        function onNonCooledComfortPulse(val, source) {
            if (val === 1) {
                if (nonCooledPulseTimer) {
                    return;
                }
                if (node.writeTopics.length > 0) {
                    const topics = writeTopicsNeedingWord(R514_COMFORT);
                    if (topics.length > 0) {
                        writeR514(R514_COMFORT, topics, "comfort-pulse");
                    }
                }
                stopNonCooledPulseTimer();
                nonCooledPulseTimer = setTimeout(() => {
                    nonCooledPulseTimer = null;
                    endNonCooledComfortPulse("comfort-pulse-timeout");
                }, COMFORT_PULSE_SEC * 1000);
                publishAll("comfort-pulse");
                updateStatus();
                return;
            }
            stopNonCooledPulseTimer();
            publishAll(source || "comfort-pulse-off");
            updateStatus();
        }

        function stopComfortPulseTimer() {
            if (comfortPulseTimer) {
                clearTimeout(comfortPulseTimer);
                comfortPulseTimer = null;
            }
        }

        function startComfortPulse(source) {
            if (!node.comfortPulseTopic || comfortPulseTimer) {
                return;
            }
            node.send({ topic: node.comfortPulseTopic, payload: 1 });
            logFanOut("comfort-pulse", source, `${node.comfortPulseTopic}=1`);
            stopComfortPulseTimer();
            comfortPulseTimer = setTimeout(() => {
                comfortPulseTimer = null;
                node.send({ topic: node.comfortPulseTopic, payload: 0 });
                logFanOut("comfort-pulse", "comfort-pulse-timeout", `${node.comfortPulseTopic}=0`);
                updateStatus();
            }, COMFORT_PULSE_SEC * 1000);
            updateStatus();
        }

        function endComfortPulse(source, writeClear) {
            stopComfortPulseTimer();
            if (writeClear !== false && node.comfortPulseTopic) {
                node.send({ topic: node.comfortPulseTopic, payload: 0 });
                logFanOut("comfort-pulse", source || "comfort-pulse-end", `${node.comfortPulseTopic}=0`);
            }
            updateStatus();
        }

        function onComfortPulseInput(payload, source) {
            const val = parseForce(payload);
            if (val === null) {
                return;
            }
            if (val === 1) {
                startComfortPulse(source);
                return;
            }
            endComfortPulse(source, false);
            updateStatus();
        }

        function onModeInput(topic, msg) {
            rememberController(msg);
            if (!Array.isArray(msg.streamValues)) {
                syncModeFromInputCache(msg && msg.controller && msg.controller.uniqueId, topic);
            }
            scheduleModeBatch(topic);
        }

        function updateStatus() {
            if (isNonCooled && node.forceTopic) {
                const pulseText = nonCooledPulseTimer ? " comfort pulse" : "";
                node.status({
                    fill: nonCooledPulseTimer ? "green" : "grey",
                    shape: "dot",
                    text: `${node.flatType} ${node.flatNumber || "?"} manual${pulseText}`
                });
                return;
            }
            if (isCooled) {
                const pulseText = comfortPulseTimer ? " P pulse" : "";
                node.status({
                    fill: comfortPulseTimer ? "green" : "yellow",
                    shape: node.enableDebug ? "ring" : "dot",
                    text: `${node.flatType} ${node.flatNumber || "?"} cooled${pulseText}`
                });
                return;
            }
            node.status({
                fill: "green",
                shape: node.enableDebug ? "ring" : "dot",
                text: node.flatType + " " + (node.flatNumber || "?")
            });
        }

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            if (!t) {
                return;
            }

            if (isNonCooled && node.forceTopic && t === node.forceTopic) {
                rememberController(msg);
                const val = parseForce(msg.payload);
                if (val === null) {
                    return;
                }
                onNonCooledComfortPulse(val, t);
                return;
            }

            const modeSvc = modeServiceKey();
            if (modeSvc && t === modeSvc && Array.isArray(msg.payload)) {
                rememberController(msg);
                applyModeArrayPayload(msg.payload, t);
                onModeInput(t, msg);
                updateStatus();
                return;
            }

            if (node.comfortPulseTopic && t === node.comfortPulseTopic) {
                onComfortPulseInput(msg.payload, t);
                updateStatus();
                return;
            }

            if (isCooled && node.valveTopics.indexOf(t) >= 0) {
                rememberController(msg);
                onValveInput(t, msg.payload, t);
                updateStatus();
                return;
            }

            if (node.modeTopics.indexOf(t) >= 0) {
                rememberController(msg);
                if (Array.isArray(msg.streamValues) && msg.streamValues.length > 0) {
                    applyModeValues(msg.streamValues, t);
                } else {
                    const n = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                    if (n === null) {
                        if (t in modeByTopic) {
                            delete modeByTopic[t];
                            clearDisplayEcoCache();
                            lastStreamModes = null;
                            rebuildLastStreamModesFromTopics();
                        }
                    } else if (modeByTopic[t] !== n) {
                        const prev = modeByTopic[t];
                        modeByTopic[t] = n;
                        noteModeTopicChange(t, n, prev);
                        clearDisplayEcoCache();
                        lastStreamModes = null;
                        rebuildLastStreamModesFromTopics();
                    } else {
                        prevModeByTopic[t] = n;
                    }
                }
                onModeInput(t, msg);
                updateStatus();
                return;
            }
        });

        if (isNonCooled) {
            publishAll("startup");
        } else if (isCooled) {
            writeSanDisplayEco("startup");
        }

        node.log(
            `${tag} started v${THERMOKON_FLAT_VERSION} type=${node.flatType} flat=${node.flatNumber || "?"}` +
            ` zones=${zoneCount}` +
            ` valves=${node.valveTopics.length}` +
            ` comfortPulse=${node.comfortPulseTopic || "none"} force=${node.forceTopic || "none"}`
        );
        if (isNonCooled && (!node.forceTopic || node.writeTopics.length === 0)) {
            node.warn(`${tag} non-cooled flat missing P comfort topic or W r514 writeTopics`);
        }
        if (isCooled && node.sanitaryWriteTopic && node.valveTopics.length === 0) {
            node.warn(`${tag} cooled flat missing valveTopics for L4 san r514 follow`);
        }
        updateStatus();
        startDisplayResyncTimer();

        node.on("close", () => {
            stopDisplayResyncTimer();
            stopModeBatchTimer();
            stopComfortPulseTimer();
            stopNonCooledPulseTimer();
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-thermokon-flat", ThermokonFlatNode);
};
