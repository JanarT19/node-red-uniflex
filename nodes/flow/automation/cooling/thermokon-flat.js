const ts = require("../../core/lib/timestamp.js");

const THERMOKON_FLAT_VERSION = "1.9.2";
const INPUT_STATE_UID_FALLBACK = "local";
const R514_ECO = 18;
const R514_COMFORT = 2;
const DEFAULT_R340_SEC = 65535;
const COMFORT_PULSE_SEC = 30;
const PIR_TICK_MS = 1000;
const PIR_HOLD_CTX_KEY = "pirHold";
const PIR_HOLD_CTX_STORE = "file";
// inactiveSince=0 => eco until first PIR=1 or restored hold from context
const PIR_DEFAULT_INACTIVE_SINCE = 0;
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
            forceTopic: `P1N${f}W.1`,
            modeTopics: [`MAN${f}W.1`, `MAN${f}W.2`],
            writeTopics: [`WAN${f}W.1`, `WAN${f}W.2`],
            displayTopics: [`E1N${f}W.1`, `E1N${f}W.2`],
            pirTopics: [],
            pirZoneIndices: [],
            sanitaryWriteTopic: "",
            comfortPulseTopic: ""
        };
    }
    if (flatType === "non-cooled-2") {
        return {
            forceTopic: `P2N${f}W.1`,
            modeTopics: [`MBN${f}W.1`, `MBN${f}W.2`, `MBN${f}W.3`],
            writeTopics: [`WBN${f}W.1`, `WBN${f}W.2`, `WBN${f}W.3`],
            displayTopics: [`E2N${f}W.1`, `E2N${f}W.2`, `E2N${f}W.3`],
            pirTopics: [],
            pirZoneIndices: [],
            sanitaryWriteTopic: "",
            comfortPulseTopic: ""
        };
    }
    if (flatType === "cooled-2") {
        return {
            forceTopic: "",
            modeTopics: [`MBC${f}V.1`],
            writeTopics: [],
            displayTopics: [`E2C${f}W.1`, `E2C${f}W.2`, `E2C${f}W.3`],
            pirTopics: [`D2C${f}W.3`, `D2C${f}W.4`],
            pirZoneIndices: [1, 2],
            r340ReadTopics: [`WBC${f}W.9`, `WBC${f}W.10`],
            sanitaryWriteTopic: `WBC${f}W.1`,
            comfortPulseTopic: `P2C${f}S.1`
        };
    }
    return {
        forceTopic: "",
        modeTopics: [`MAC${f}V.1`],
        writeTopics: [],
        displayTopics: [`E1C${f}W.1`, `E1C${f}W.2`],
        pirTopics: [`D1C${f}W.2`],
        pirZoneIndices: [1],
        r340ReadTopics: [`WAC${f}W.2`],
        sanitaryWriteTopic: `WAC${f}W.1`,
        comfortPulseTopic: `P1C${f}S.1`
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
        const r340HoldRaw = config.r340HoldSec;
        const r340HoldParsed = r340HoldRaw === "" || r340HoldRaw == null ? DEFAULT_R340_SEC : Number(r340HoldRaw);
        node.r340FallbackSec = Math.max(0, Number.isFinite(r340HoldParsed) ? r340HoldParsed : DEFAULT_R340_SEC);

        const preset = buildPreset(node.flatType, node.flatNumber);
        node.forceTopic = (config.forceTopic || (preset && preset.forceTopic) || "").trim();
        node.writeTopics = parseTopicList(config.writeTopics || (preset && preset.writeTopics.join(",")));
        node.modeTopics = parseTopicList(config.modeTopics || (preset && preset.modeTopics.join(",")));
        node.displayTopics = parseTopicList(config.displayTopics || (preset && preset.displayTopics.join(",")));
        node.pirTopics = parseTopicList(config.pirTopics || (preset && preset.pirTopics.join(",")));
        node.comfortPulseTopic = (config.comfortPulseTopic || (preset && preset.comfortPulseTopic) || "").trim();
        node.sanitaryWriteTopic = (config.sanitaryWriteTopic || (preset && preset.sanitaryWriteTopic) || "").trim();
        node.pirZoneIndices = parseIndexList(config.pirZoneIndices || (preset && preset.pirZoneIndices.join(",")));
        node.r340ReadTopics = parseTopicList(config.r340ReadTopics || (preset && preset.r340ReadTopics && preset.r340ReadTopics.join(",")));

        const isNonCooled = node.flatType.startsWith("non-cooled");
        const isCooled = !isNonCooled;
        const zoneCount = node.displayTopics.length;

        const modeByTopic = {};
        const displayEcoByZone = new Array(zoneCount).fill(null);
        const pirStateByTopic = {};
        const pirSeenByTopic = {};
        let lastWrittenWord = null;
        let lastPanelSyncMs = 0;
        let lastSanitaryWord = null;
        const prevModeByTopic = {};
        let pendingPanelSyncZone = null;
        let pirTimer = null;
        let displayResyncTimer = null;
        let modeBatchTimer = null;
        let comfortPulseTimer = null;
        let nonCooledPulseTimer = null;
        let lastInputUniqueId = "";
        // Full MBN array from the latest streamValues packet (source of truth for E display).
        let lastStreamModes = null;
        const ecoSinceMsByZone = new Array(zoneCount).fill(0);
        const lastHoldEdgeSecByZone = new Array(zoneCount).fill(null);
        const r340ByTopic = {};

        function parseTopicList(raw) {
            return String(raw || "")
                .split(/[,;\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
        }

        function parseIndexList(raw) {
            if (Array.isArray(raw)) {
                return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
            }
            return String(raw || "")
                .split(/[,;\s]+/)
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n));
        }

        function pirTopicForZone(zoneIdx) {
            const pos = node.pirZoneIndices.indexOf(zoneIdx);
            if (pos < 0) {
                return "";
            }
            return node.pirTopics[pos] || "";
        }

        function r340TopicForZone(zoneIdx) {
            const pos = node.pirZoneIndices.indexOf(zoneIdx);
            if (pos < 0) {
                return "";
            }
            return node.r340ReadTopics[pos] || "";
        }

        function parseR340Sec(payload) {
            if (payload == null || payload === "") {
                return null;
            }
            const n = Number(payload);
            if (!Number.isFinite(n) || n < 0) {
                return null;
            }
            return Math.max(0, n);
        }

        function r340HoldSecForZone(zoneIdx) {
            const topic = r340TopicForZone(zoneIdx);
            if (topic && Object.prototype.hasOwnProperty.call(r340ByTopic, topic)) {
                return r340ByTopic[topic];
            }
            return node.r340FallbackSec;
        }

        function r340HoldSummarySec() {
            if (node.r340ReadTopics.length === 0) {
                return node.r340FallbackSec;
            }
            const vals = node.r340ReadTopics.filter((topic) => Object.prototype.hasOwnProperty.call(r340ByTopic, topic)).map((topic) => r340ByTopic[topic]);
            if (vals.length === 0) {
                return node.r340FallbackSec;
            }
            return vals[0];
        }

        function isPirZone(zoneIdx) {
            return node.pirZoneIndices.indexOf(zoneIdx) >= 0;
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

        function isEcoMode(r277) {
            const v = Number(r277);
            return v === 18 || v === 0;
        }

        function isActiveEcoMode(r277) {
            return Number(r277) === 18;
        }

        function isComfortMode(r277) {
            return Number(r277) === 2;
        }

        function targetWordFromR277(r277) {
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
                if (mt && mt in modeByTopic) {
                    const cur = modeByTopic[mt];
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

        function isThermokonOff(r277) {
            return Number(r277) === 0;
        }

        function pirActive(payload) {
            if (payload == null || payload === "") {
                return false;
            }
            const n = Number(payload);
            if (Number.isFinite(n)) {
                return n >= 1;
            }
            return !!payload;
        }

        function defaultPirState() {
            return { active: false, inactiveSince: PIR_DEFAULT_INACTIVE_SINCE };
        }

        function normalizePirState(raw) {
            if (!raw || typeof raw !== "object") {
                return defaultPirState();
            }
            return {
                active: !!raw.active,
                inactiveSince: Number(raw.inactiveSince) || PIR_DEFAULT_INACTIVE_SINCE
            };
        }

        function getPirState(topic) {
            let st = pirStateByTopic[topic];
            if (!st) {
                st = defaultPirState();
                pirStateByTopic[topic] = st;
            }
            return st;
        }

        function loadPirHoldFromContext() {
            if (!isCooled || node.pirTopics.length === 0) {
                return false;
            }
            let any = false;
            try {
                const raw = node.context().get(PIR_HOLD_CTX_KEY, PIR_HOLD_CTX_STORE);
                if (!raw || typeof raw !== "object") {
                    return false;
                }
                for (let i = 0; i < node.pirTopics.length; i++) {
                    const topic = node.pirTopics[i];
                    if (!Object.prototype.hasOwnProperty.call(raw, topic)) {
                        continue;
                    }
                    pirStateByTopic[topic] = normalizePirState(raw[topic]);
                    pirSeenByTopic[topic] = true;
                    any = true;
                }
                if (any && node.enableDebug) {
                    node.log(`${tag} PIR hold restored from context`);
                }
            } catch (err) {
                node.warn(`${tag} PIR hold load failed: ${String(err.message || err)}`);
            }
            return any;
        }

        function savePirHoldToContext() {
            if (!isCooled || node.pirTopics.length === 0) {
                return;
            }
            const out = {};
            for (let i = 0; i < node.pirTopics.length; i++) {
                const topic = node.pirTopics[i];
                if (!pirSeenByTopic[topic]) {
                    continue;
                }
                const st = pirStateByTopic[topic];
                if (st) {
                    out[topic] = { active: st.active, inactiveSince: st.inactiveSince };
                }
            }
            try {
                node.context().set(PIR_HOLD_CTX_KEY, out, PIR_HOLD_CTX_STORE);
            } catch (err) {
                node.warn(`${tag} PIR hold save failed: ${String(err.message || err)}`);
            }
        }

        function zoneComfort(zoneIdx) {
            if (isPirZone(zoneIdx)) {
                const pt = pirTopicForZone(zoneIdx);
                const st = pirStateByTopic[pt];
                if (!st) {
                    return false;
                }
                if (st.active) {
                    return true;
                }
                const elapsedSec = (Date.now() - st.inactiveSince) / 1000;
                return elapsedSec < r340HoldSecForZone(zoneIdx);
            }
            const mt = node.modeTopics[zoneIdx];
            if (!mt || !(mt in modeByTopic)) {
                return false;
            }
            return isComfortMode(modeByTopic[mt]);
        }

        function cooledSanitaryDisplayEco() {
            for (let i = 0; i < node.pirZoneIndices.length; i++) {
                if (zoneComfort(node.pirZoneIndices[i])) {
                    return 0;
                }
            }
            return 1;
        }

        function zoneDisplayEco(zoneIdx) {
            const mt = node.modeTopics[zoneIdx];
            if (isCooled) {
                if (isPirZone(zoneIdx)) {
                    return zoneComfort(zoneIdx) ? 0 : 1;
                }
                return cooledSanitaryDisplayEco();
            }
            if (isPirZone(zoneIdx)) {
                if (mt && mt in modeByTopic && isThermokonOff(modeByTopic[mt])) {
                    return 1;
                }
                return zoneComfort(zoneIdx) ? 0 : 1;
            }
            if (!mt || !(mt in modeByTopic)) {
                return null;
            }
            return isEcoMode(modeByTopic[mt]) ? 1 : 0;
        }

        function computeCooledDisplayEcoArray() {
            const arr = [];
            for (let zi = 0; zi < zoneCount; zi++) {
                arr.push(zoneDisplayEco(zi));
            }
            return arr;
        }

        function modeSummary() {
            return node.modeTopics
                .map((mt) => {
                    if (!(mt in modeByTopic)) {
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
            for (let i = 0; i < zoneCount; i++) {
                const n = Number(modes[i]);
                if (!Number.isFinite(n)) {
                    return null;
                }
                arr.push(isEcoMode(n) ? 1 : 0);
            }
            return arr;
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
            publishAll(reason || "mode-batch");
            if (isNonCooled) {
                flushPendingPanelSync(reason || "mode-batch");
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

        function supplementHoldKey() {
            const ek = displayServiceKey();
            if (ek.startsWith("E1C")) {
                return "HAC" + ek.slice(3);
            }
            if (ek.startsWith("E2C")) {
                return "HBC" + ek.slice(3);
            }
            return "";
        }

        function touchEcoSince(zoneIdx, eco) {
            if (eco === 1) {
                if (!ecoSinceMsByZone[zoneIdx]) {
                    ecoSinceMsByZone[zoneIdx] = Date.now();
                }
            } else if (eco === 0) {
                ecoSinceMsByZone[zoneIdx] = 0;
            }
        }

        function computeHoldEdgeSecForZone(zoneIdx) {
            if (!isCooled || !isPirZone(zoneIdx)) {
                return null;
            }
            const pt = pirTopicForZone(zoneIdx);
            const st = pirStateByTopic[pt];
            let eco = displayEcoByZone[zoneIdx];
            if (eco === null) {
                eco = zoneDisplayEco(zoneIdx);
            }
            if (st && st.active) {
                return null;
            }
            if (eco === 1) {
                const since = ecoSinceMsByZone[zoneIdx];
                if (since > 0) {
                    return Math.floor(since / 1000);
                }
                return null;
            }
            if (!st || st.inactiveSince <= 0) {
                return null;
            }
            const deadlineMs = st.inactiveSince + r340HoldSecForZone(zoneIdx) * 1000;
            return Math.floor(deadlineMs / 1000);
        }

        function writeHoldSupplement(reason) {
            if (!isCooled) {
                return;
            }
            const hk = supplementHoldKey();
            if (!hk) {
                return;
            }
            const reasonStr = String(reason || "");
            const forcePush = reasonStr === "resync" || reasonStr.indexOf("force") >= 0;
            const arr = [];
            let anyChange = forcePush;
            for (let zi = 0; zi < zoneCount; zi++) {
                const edgeSec = computeHoldEdgeSecForZone(zi);
                arr.push(edgeSec);
                if (lastHoldEdgeSecByZone[zi] !== edgeSec) {
                    anyChange = true;
                }
            }
            if (!anyChange) {
                return;
            }
            for (let zi = 0; zi < zoneCount; zi++) {
                lastHoldEdgeSecByZone[zi] = arr[zi];
            }
            node.send({ topic: hk, payload: arr });
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
                const n = Number(modes[i]);
                if (!Number.isFinite(n)) {
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
                lastStreamModes = modes.slice(0, node.modeTopics.length).map((v) => Number(v));
            }
            if (any) {
                clearDisplayEcoCache();
                node.warn(`${tag} M sync (${reason || "?"}) ${modeServiceKey()}=${modeSummary()}`);
            }
            return any;
        }

        function syncR340FromInputCache(uniqueId) {
            if (node.r340ReadTopics.length === 0) {
                return false;
            }
            const inputStates = resolveInputStates(uniqueId);
            if (!inputStates) {
                return false;
            }
            let any = false;
            for (let i = 0; i < node.r340ReadTopics.length; i++) {
                const topic = node.r340ReadTopics[i];
                const m = topic.match(/^([A-Z0-9]+W)\.(\d+)$/);
                if (!m) {
                    continue;
                }
                const svcKey = m[1];
                const member = Number(m[2]);
                const st = inputStates[svcKey];
                const values = st && st.values;
                if (!Array.isArray(values) || member < 1 || member > values.length) {
                    continue;
                }
                const sec = parseR340Sec(values[member - 1]);
                if (sec === null) {
                    continue;
                }
                if (r340ByTopic[topic] !== sec) {
                    r340ByTopic[topic] = sec;
                    any = true;
                }
            }
            if (any && node.enableDebug) {
                node.log(`${tag} r340 seeded from input cache`);
            }
            return any;
        }

        function onR340Input(topic, payload) {
            const sec = parseR340Sec(payload);
            if (sec === null) {
                return;
            }
            if (r340ByTopic[topic] === sec) {
                return;
            }
            r340ByTopic[topic] = sec;
            if (node.enableDebug) {
                node.log(`${tag} r340 ${topic}=${sec}s`);
            }
            publishAll("r340 read");
            updateStatus();
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
                if (raw == null || raw === "UNKN") {
                    continue;
                }
                const n = Number(raw);
                if (!Number.isFinite(n)) {
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
                if (anyKnown) {
                    // Re-push all E zones with known M (retries failed setup writes).
                    writeDisplayEco("resync");
                }
            }, DISPLAY_RESYNC_MS);
        }

        function sendOut(messages) {
            if (!messages || messages.length === 0) {
                return;
            }
            node.send(messages);
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
            const forceChange = reason === "force-change" || reason === "comfort-pulse" || isPanelSyncReason(reason);
            if (!forceChange && lastWrittenWord === word) {
                return;
            }
            lastWrittenWord = word;
            sendR514ToWriteNode(word, topics);
            const line = `${tag} W r514=${word} (${reason}) -> ${topics.join(", ")}`;
            if (forceChange) {
                node.warn(line);
            } else if (node.enableDebug) {
                node.log(line);
            }
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
            const fullArr = isCooled ? computeCooledDisplayEcoArray() : computeDisplayEcoArray();

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
                    touchEcoSince(zi, fullArr[zi]);
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
                touchEcoSince(zi, eco);
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

        function updateSanitaryR514(reason) {
            if (!node.sanitaryWriteTopic || node.pirZoneIndices.length === 0) {
                return;
            }
            let allEco = true;
            for (let i = 0; i < node.pirZoneIndices.length; i++) {
                if (zoneComfort(node.pirZoneIndices[i])) {
                    allEco = false;
                    break;
                }
            }
            const word = allEco ? R514_ECO : R514_COMFORT;
            if (lastSanitaryWord === word) {
                return;
            }
            lastSanitaryWord = word;
            sendOut([{ topic: node.sanitaryWriteTopic, payload: word }]);
            if (node.enableDebug) {
                node.log(`${tag} sanitary r514=${word} (${reason})`);
            }
        }

        function publishAll(reason) {
            writeDisplayEco(reason);
            if (isCooled) {
                updateSanitaryR514(reason);
                writeHoldSupplement(reason);
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
            }
            publishAll(reason || "comfort-pulse-end");
            updateStatus();
            if (node.enableDebug) {
                node.log(`${tag} non-cooled comfort pulse end (${reason || "?"})`);
            }
        }

        function onNonCooledComfortPulse(val, source) {
            if (val === 1) {
                if (nonCooledPulseTimer) {
                    return;
                }
                if (node.writeTopics.length > 0) {
                    writeR514(R514_COMFORT, node.writeTopics, "comfort-pulse");
                }
                stopNonCooledPulseTimer();
                nonCooledPulseTimer = setTimeout(() => {
                    nonCooledPulseTimer = null;
                    endNonCooledComfortPulse("comfort-pulse-timeout");
                }, COMFORT_PULSE_SEC * 1000);
                publishAll("comfort-pulse");
                updateStatus();
                node.warn(`${tag} non-cooled comfort pulse start (${source}) ` + `${COMFORT_PULSE_SEC}s -> ${node.writeTopics.join(",") || "?"}`);
                return;
            }
            stopNonCooledPulseTimer();
            publishAll(source || "comfort-pulse-off");
            updateStatus();
        }

        function onPirInput(topic, payload) {
            const active = pirActive(payload);
            const st = getPirState(topic);
            if (!pirSeenByTopic[topic]) {
                pirSeenByTopic[topic] = true;
                st.active = active;
                if (active) {
                    st.inactiveSince = Date.now();
                } else {
                    st.inactiveSince = PIR_DEFAULT_INACTIVE_SINCE;
                }
                savePirHoldToContext();
                if (node.enableDebug) {
                    node.log(`${tag} PIR first sample ${topic}=${active ? 1 : 0}`);
                }
                publishAll(topic);
                return;
            }
            if (active === st.active) {
                return;
            }
            st.active = active;
            st.inactiveSince = Date.now();
            savePirHoldToContext();
            if (node.enableDebug) {
                node.log(`${tag} PIR ${topic}=${active ? 1 : 0}`);
            }
            publishAll(topic);
        }

        function stopComfortPulseTimer() {
            if (comfortPulseTimer) {
                clearTimeout(comfortPulseTimer);
                comfortPulseTimer = null;
            }
        }

        function forceComfortAllPirZones(reason) {
            for (let i = 0; i < node.pirTopics.length; i++) {
                const topic = node.pirTopics[i];
                const st = getPirState(topic);
                pirSeenByTopic[topic] = true;
                st.active = true;
                st.inactiveSince = Date.now();
            }
            savePirHoldToContext();
            publishAll(reason || "comfort-pulse");
        }

        function endComfortPulse(reason, writeClear) {
            stopComfortPulseTimer();
            const now = Date.now();
            for (let i = 0; i < node.pirTopics.length; i++) {
                const topic = node.pirTopics[i];
                const st = getPirState(topic);
                if (st.active) {
                    st.active = false;
                    st.inactiveSince = now;
                }
            }
            savePirHoldToContext();
            if (writeClear !== false && node.comfortPulseTopic) {
                node.send({ topic: node.comfortPulseTopic, payload: 0 });
            }
            publishAll(reason || "comfort-pulse-end");
            updateStatus();
            if (node.enableDebug) {
                node.log(`${tag} comfort pulse end (${reason || "?"})`);
            }
        }

        function startComfortPulse(source) {
            forceComfortAllPirZones(source);
            stopComfortPulseTimer();
            comfortPulseTimer = setTimeout(() => {
                comfortPulseTimer = null;
                endComfortPulse("comfort-pulse-timeout");
            }, COMFORT_PULSE_SEC * 1000);
            updateStatus();
            if (node.enableDebug) {
                node.log(`${tag} comfort pulse start (${source}) ${COMFORT_PULSE_SEC}s`);
            }
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

        function onPirTick() {
            if (!isCooled || node.pirTopics.length === 0) {
                return;
            }
            let anyChange = false;
            for (let zi = 0; zi < zoneCount; zi++) {
                if (!isPirZone(zi)) {
                    continue;
                }
                const nextEco = zoneDisplayEco(zi);
                if (nextEco !== null && displayEcoByZone[zi] !== nextEco) {
                    anyChange = true;
                    break;
                }
            }
            if (anyChange) {
                publishAll("r340 tick");
            } else {
                updateSanitaryR514("r340 tick");
            }
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
            if (isCooled && node.pirTopics.length > 0) {
                const anyComfort = node.pirZoneIndices.some((zi) => zoneComfort(zi));
                const pulseText = comfortPulseTimer ? " comfort pulse" : "";
                const r340Txt = node.r340ReadTopics.length > 0 ? ` r340=${r340HoldSummarySec()}s` : "";
                node.status({
                    fill: anyComfort ? "green" : "yellow",
                    shape: node.enableDebug ? "ring" : "dot",
                    text: `${node.flatType} ${node.flatNumber || "?"} PIR${r340Txt}${pulseText}`
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

            if (node.pirTopics.indexOf(t) >= 0) {
                onPirInput(t, msg.payload);
                updateStatus();
                return;
            }

            if (node.r340ReadTopics.indexOf(t) >= 0) {
                rememberController(msg);
                onR340Input(t, msg.payload);
                return;
            }

            if (node.modeTopics.indexOf(t) >= 0) {
                rememberController(msg);
                if (Array.isArray(msg.streamValues) && msg.streamValues.length > 0) {
                    applyModeValues(msg.streamValues, t);
                } else {
                    const n = Number(msg.payload);
                    if (Number.isFinite(n) && modeByTopic[t] !== n) {
                        const prev = modeByTopic[t];
                        modeByTopic[t] = n;
                        noteModeTopicChange(t, n, prev);
                        clearDisplayEcoCache();
                        lastStreamModes = null;
                        rebuildLastStreamModesFromTopics();
                    } else if (Number.isFinite(n)) {
                        prevModeByTopic[t] = n;
                    }
                }
                onModeInput(t, msg);
                updateStatus();
                return;
            }
        });

        if (isCooled && node.pirTopics.length > 0) {
            syncR340FromInputCache(lastInputUniqueId);
            const restored = loadPirHoldFromContext();
            publishAll(restored ? "pir-restore" : "startup");
            pirTimer = setInterval(onPirTick, PIR_TICK_MS);
        }

        node.log(
            `${tag} started v${THERMOKON_FLAT_VERSION} type=${node.flatType} flat=${node.flatNumber || "?"}` +
                ` zones=${zoneCount} PIR=${node.pirTopics.length} r340=${r340HoldSummarySec()}s` +
                ` r340Topics=${node.r340ReadTopics.length ? node.r340ReadTopics.join(",") : "none"}` +
                ` comfortPulse=${node.comfortPulseTopic || "none"} force=${node.forceTopic || "none"}`
        );
        if (isCooled && node.pirTopics.length > 0 && node.r340ReadTopics.length === 0) {
            node.warn(`${tag} cooled flat missing WAC/WBC r340 read topics`);
        }
        if (isNonCooled && (!node.forceTopic || node.writeTopics.length === 0)) {
            node.warn(`${tag} non-cooled flat missing P comfort topic or W r514 writeTopics`);
        }
        updateStatus();
        startDisplayResyncTimer();

        node.on("close", () => {
            stopDisplayResyncTimer();
            stopModeBatchTimer();
            stopComfortPulseTimer();
            stopNonCooledPulseTimer();
            if (pirTimer) {
                clearInterval(pirTimer);
                pirTimer = null;
            }
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-thermokon-flat", ThermokonFlatNode);
};
