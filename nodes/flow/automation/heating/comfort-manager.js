const ts = require("../../core/lib/timestamp.js");
/**
 * comfort-manager.js
 * Node-RED node: uniflex-comfort-manager
 *
 * Which rooms may be heated or cooled, automatically or from HCMW.
 * Heat tick: room counts toward heatingRequired, and HCMW.1 holds its
 * floor feedforward at +chargeMaxDeg.
 * Cool tick: while auto-cool is on, every ticked room's valve is forced open.
 * Auto-cool follows TERW.1 against TERW.3, not a single room.
 * HCMW.2 forces those valves open immediately.
 *
 * Room temperatures for heating still come from roomForecasts.
 * TERW, HCMW and the spot price come from the input wire.
 *
 * Version: 1.1.0-terw-avg
 */

const DEFAULT_ROOM_FOW_MAP = {
    M3_air: ["FOW.8"],
    M2_air: ["FOW.7"],
    "1k_shower_air": ["FOW.1"],
    kab_air: ["FOW.4"],
    M1_air: ["FOW.6"],
    rodu_air: ["FOW.13"],
    "2k_dush": ["FOW.12"],
    elu_air: ["FOW.2"],
    hall_air: ["FOW.3"],
    MB_air: ["FOW.9"],
    MBgarde_air: ["FOW.10"],
    MBvann_air: ["FOW.11"]
};

const DEFAULT_ROWS = [
    { name: "M3_air", heat: true, cool: true },
    { name: "M2_air", heat: true, cool: true },
    { name: "1k_shower_air", heat: true, cool: true },
    { name: "kab_air", heat: true, cool: true },
    { name: "M1_air", heat: true, cool: true },
    { name: "rodu_air", heat: true, cool: true },
    { name: "2k_dush", heat: true, cool: true },
    { name: "elu_air", heat: true, cool: true },
    { name: "hall_air", heat: true, cool: true },
    { name: "MB_air", heat: true, cool: true },
    { name: "MBgarde_air", heat: true, cool: true },
    { name: "MBvann_air", heat: true, cool: true },
    { name: "WG_air", heat: false, cool: false }
];

module.exports = function (RED) {
    const NODE_VERSION = "1.1.0-terw-avg";
    const AVG_BAND_C = 0.1;

    function ComfortManagerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const staleThresholdHours = parseFloat(config.staleThresholdHours) || 2.0;
        const staleThresholdMs = staleThresholdHours * 3600 * 1000;
        const coolPriceLimit = parseFloat(config.coolPriceLimit);
        const coolPriceHyst = parseFloat(config.coolPriceHyst);
        const avgErrTopic = (config.avgErrTopic || "TERW.1").trim();
        const coolLimitTopic = (config.coolLimitTopic || "TERW.3").trim();
        const heatOutTopic = (config.heatOutTopic || "MPCGW.8").trim();
        const coolOutTopic = (config.coolOutTopic || "MPCGW.9").trim();
        const coolingRequiredTopic = (config.coolingRequiredTopic || "heating/coolingRequired").trim();
        const spotPriceTopic = (config.spotPriceTopic || "PRENW.3").trim();
        const hcmwForceHeatTopic = (config.hcmwForceHeatTopic || "HCMW.1").trim();
        const hcmwForceCoolTopic = (config.hcmwForceCoolTopic || "HCMW.2").trim();

        const PRICE_ON = Number.isFinite(coolPriceLimit) ? coolPriceLimit : 50;
        const PRICE_OFF = PRICE_ON + (Number.isFinite(coolPriceHyst) ? coolPriceHyst : 5);

        let roomToFowMap = DEFAULT_ROOM_FOW_MAP;
        try {
            const rawMap = (config.roomToFowMap || "").trim();
            if (rawMap) roomToFowMap = JSON.parse(rawMap);
        } catch (e) {
            node.warn(`[comfort-manager] invalid room-to-FOW JSON, using k20 defaults: ${e.message}`);
        }

        let rows = [];
        try {
            const rawRows = (config.roomRows || "").trim();
            if (rawRows) rows = JSON.parse(rawRows);
        } catch (e) {
            node.warn(`[comfort-manager] invalid room list, using defaults: ${e.message}`);
            rows = [];
        }
        if (!Array.isArray(rows) || rows.length === 0) rows = DEFAULT_ROWS;

        const heatSet = new Set();
        const coolSet = new Set();
        for (const r of rows) {
            if (!r || !r.name) continue;
            const name = String(r.name).trim();
            if (!name) continue;
            if (r.heat) heatSet.add(name);
            if (r.cool) coolSet.add(name);
        }

        let spotPrice = null;
        let avgErr = null;
        let coolLimit = null;
        let autoCoolOn = false;
        let forceHeat = 0;
        let forceCool = 0;
        let priceOk = false;
        let warnedNoTerw = false;
        const fowOut = {};
        const warnedNoFow = new Set();
        let warnedNoHeat = false;
        let lastLog = "";
        let lastHeatOut = null;
        let lastCoolOut = null;

        node.log(
            `[comfort-manager] *** VERSION ${NODE_VERSION} *** | heat=${[...heatSet].join(",")} cool=${[...coolSet].join(",")} ` +
                `avg=${avgErrTopic} lim=${coolLimitTopic} band=${AVG_BAND_C} price<${PRICE_ON}`
        );

        function readRoomForecasts() {
            const g = node.context().global.get("roomForecasts");
            if (g && typeof g === "object" && Object.keys(g).length > 0) return g;
            return node.context().flow.get("roomForecasts") || {};
        }

        function freshRooms() {
            const forecasts = readRoomForecasts();
            const now = Date.now();
            const out = [];
            for (const [roomName, roomData] of Object.entries(forecasts)) {
                if (!roomData || !roomData.healthy) continue;
                if (now - roomData.timestamp > staleThresholdMs) continue;
                out.push({ name: roomName, ...roomData });
            }
            return out;
        }

        function updatePriceOk() {
            if (spotPrice == null || !Number.isFinite(spotPrice)) return;
            if (!priceOk && spotPrice < PRICE_ON) priceOk = true;
            else if (priceOk && spotPrice > PRICE_OFF) priceOk = false;
        }

        function publishManual() {
            let maxDeg = 2;
            const sig = node.context().global.get("chargeSignal");
            if (sig && Number.isFinite(sig.maxDeg) && sig.maxDeg > 0) maxDeg = sig.maxDeg;
            const rooms = {};
            for (const name of heatSet) rooms[name] = { heat: true, cool: coolSet.has(name) };
            for (const name of coolSet) {
                if (!rooms[name]) rooms[name] = { heat: false, cool: true };
            }
            node.context().global.set("hcmwManual", {
                heat: forceHeat,
                cool: forceCool,
                maxDeg: maxDeg,
                rooms: rooms,
                ts: Date.now()
            });
        }

        function fowTopicsFor(roomName) {
            const topics = roomToFowMap[roomName];
            if (!Array.isArray(topics) || topics.length === 0) {
                if (!warnedNoFow.has(roomName)) {
                    warnedNoFow.add(roomName);
                    node.warn(`[comfort-manager] ${roomName} is ticked for cool but has no FOW in the map`);
                }
                return [];
            }
            return topics.map((t) => String(t).trim()).filter(Boolean);
        }

        function setFow(topic, want, msgs) {
            const prev = fowOut[topic];
            if (prev === undefined) {
                fowOut[topic] = 0;
                if (want === 0) return;
            }
            if (fowOut[topic] === want) return;
            fowOut[topic] = want;
            msgs.push({ topic: topic, payload: want });
        }

        function updateAutoCool() {
            if (!Number.isFinite(avgErr) || !Number.isFinite(coolLimit)) {
                if (!warnedNoTerw) {
                    node.warn(`[comfort-manager] waiting for ${avgErrTopic} and ${coolLimitTopic}`);
                    warnedNoTerw = true;
                }
                return;
            }
            warnedNoTerw = false;
            if (!autoCoolOn && avgErr > coolLimit + AVG_BAND_C) autoCoolOn = true;
            else if (autoCoolOn && avgErr < coolLimit - AVG_BAND_C) autoCoolOn = false;
        }

        function check() {
            publishManual();
            const rooms = freshRooms();
            const msgs = [];

            let heatingRequired = false;
            let urgentName = "";
            let urgentErr = 0;
            let heatSeen = 0;
            for (const room of rooms) {
                if (!heatSet.has(room.name)) continue;
                heatSeen++;
                const tset = Number(room.Tset);
                const ti = Number(room.Ti_now);
                const currentError = Number.isFinite(tset) && Number.isFinite(ti) ? tset - ti : 0;
                let roomMinT = NaN;
                if (Array.isArray(room.Ti_forecast_noHeat) && room.Ti_forecast_noHeat.length > 0) {
                    roomMinT = Math.min(...room.Ti_forecast_noHeat.map(Number));
                }
                const roomTmin = Number.isFinite(room.Tmin) ? room.Tmin : tset - 0.3;
                const futureCold = Number.isFinite(roomMinT) && Number.isFinite(roomTmin) && roomMinT < roomTmin;
                if (currentError > 0.3 || futureCold) heatingRequired = true;
                if (currentError > urgentErr) {
                    urgentErr = currentError;
                    urgentName = room.name;
                }
            }
            if (heatSeen === 0) {
                heatingRequired = true;
                if (!warnedNoHeat) {
                    node.warn("[comfort-manager] No fresh heat-ticked room forecasts -- heatingRequired=1");
                    warnedNoHeat = true;
                }
            } else {
                warnedNoHeat = false;
            }
            const heatBit = heatingRequired ? 1 : 0;
            node.context().flow.set("heatingRequired", heatBit);
            if (heatOutTopic && lastHeatOut !== heatBit) {
                lastHeatOut = heatBit;
                msgs.push({ topic: heatOutTopic, payload: heatBit });
            }

            const wantFow = new Set();
            let coolingRequired = 0;
            let mode = "idle";

            if (forceCool) {
                mode = "force-cool";
                for (const name of coolSet) {
                    for (const topic of fowTopicsFor(name)) wantFow.add(topic);
                }
            } else if (forceHeat) {
                mode = "force-heat";
            } else {
                updateAutoCool();
                if (autoCoolOn && priceOk) {
                    coolingRequired = 1;
                    mode = "auto-cool";
                    for (const name of coolSet) {
                        for (const topic of fowTopicsFor(name)) wantFow.add(topic);
                    }
                } else if (autoCoolOn && !priceOk) {
                    mode = "hot-wait-price";
                }
            }

            node.context().flow.set("coolingRequired", coolingRequired);
            if (lastCoolOut !== coolingRequired) {
                lastCoolOut = coolingRequired;
                if (coolingRequiredTopic) msgs.push({ topic: coolingRequiredTopic, payload: coolingRequired });
                if (coolOutTopic) msgs.push({ topic: coolOutTopic, payload: coolingRequired });
            }

            const allTopics = new Set(Object.keys(fowOut));
            for (const name of coolSet) {
                for (const topic of fowTopicsFor(name)) allTopics.add(topic);
            }
            for (const topic of allTopics) setFow(topic, wantFow.has(topic) ? 1 : 0, msgs);

            if (msgs.length > 0) node.send([msgs]);

            const priceStr = spotPrice != null && Number.isFinite(spotPrice) ? spotPrice.toFixed(1) : "n/a";
            const avgStr = Number.isFinite(avgErr) ? avgErr.toFixed(1) : "n/a";
            const limStr = Number.isFinite(coolLimit) ? coolLimit.toFixed(1) : "n/a";
            let statusText = `idle avg=${avgStr}/${limStr} p=${priceStr}`;
            let fill = "green";
            if (mode === "force-heat") {
                statusText = `HCMW heat FF p=${priceStr}`;
                fill = "red";
            } else if (mode === "force-cool") {
                statusText = `HCMW cool open ${coolSet.size}r p=${priceStr}`;
                fill = "blue";
            } else if (mode === "auto-cool") {
                statusText = `auto cool avg=${avgStr}/${limStr} p=${priceStr}`;
                fill = "blue";
            } else if (mode === "hot-wait-price") {
                statusText = `avg hot wait price ${avgStr}/${limStr} p=${priceStr}`;
                fill = "yellow";
            } else if (heatingRequired && urgentName) {
                statusText = `heat ${urgentName} ${urgentErr.toFixed(1)}C p=${priceStr}`;
                fill = "yellow";
            }
            statusText += ` (${ts.formatStatus()})`;
            node.status({ fill: fill, shape: "dot", text: statusText });

            const logLine = `${mode} heatReq=${heatingRequired ? 1 : 0} coolReq=${coolingRequired} avg=${avgStr}/${limStr} fow=${wantFow.size} p=${priceStr}`;
            if (logLine !== lastLog) {
                node.log(`[comfort-manager] ${logLine}`);
                lastLog = logLine;
            }
        }

        setTimeout(() => check(), 15000);
        const periodicInterval = setInterval(() => check(), 5 * 60 * 1000);

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            let relevant = false;
            if (avgErrTopic && t === avgErrTopic) {
                const v = msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : Number(msg.payload);
                if (v !== null) {
                    avgErr = v;
                    relevant = true;
                }
            } else if (coolLimitTopic && t === coolLimitTopic) {
                const v = msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : Number(msg.payload);
                if (v !== null) {
                    coolLimit = v;
                    relevant = true;
                }
            } else if (spotPriceTopic && t === spotPriceTopic) {
                const v = msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : Number(msg.payload);
                if (v !== null) {
                    spotPrice = v;
                    updatePriceOk();
                    relevant = true;
                }
            } else if (hcmwForceHeatTopic && t === hcmwForceHeatTopic) {
                if (msg.payload != null && Number.isFinite(Number(msg.payload))) {
                    forceHeat = Number(msg.payload) !== 0 ? 1 : 0;
                    relevant = true;
                }
            } else if (hcmwForceCoolTopic && t === hcmwForceCoolTopic) {
                if (msg.payload != null && Number.isFinite(Number(msg.payload))) {
                    forceCool = Number(msg.payload) !== 0 ? 1 : 0;
                    relevant = true;
                }
            }
            if (relevant) check();
        });

        node.on("close", () => {
            clearInterval(periodicInterval);
        });
    }

    RED.nodes.registerType("uniflex-comfort-manager", ComfortManagerNode);
};
