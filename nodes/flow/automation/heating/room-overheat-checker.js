const ts = require("../../core/lib/timestamp.js");
/**
 * room-overheat-checker.js
 * Node-RED node: uniflex-room-overheat-checker
 *
 * Per-room auto-cooling decision (excess above Tset, symmetric hysteresis),
 * price gate, optional forecast anticipatory start. Writes FOW for hot rooms.
 *
 * Version: 1.0.0
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

module.exports = function (RED) {
    function RoomOverheatCheckerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const staleThresholdHours = parseFloat(config.staleThresholdHours) || 2.0;
        const staleThresholdMs = staleThresholdHours * 3600 * 1000;
        const coolExcessOn = parseFloat(config.coolExcessOn);
        const coolExcessHyst = parseFloat(config.coolExcessHyst);
        const coolPriceLimit = parseFloat(config.coolPriceLimit);
        const coolPriceHyst = parseFloat(config.coolPriceHyst);
        const outputTopic = (config.outputTopic || "MPCGW.9").trim();
        const coolingRequiredTopic = (config.coolingRequiredTopic || "heating/coolingRequired").trim();
        const spotPriceTopic = (config.spotPriceTopic || "PRENW.3").trim();
        const hcmwForceHeatTopic = (config.hcmwForceHeatTopic || "HCMW.1").trim();
        const hcmwForceCoolTopic = (config.hcmwForceCoolTopic || "HCMW.2").trim();
        const enableAutoFow = config.enableAutoFow !== false;

        const E_REF = Number.isFinite(coolExcessOn) ? coolExcessOn : 2.5;
        const HYS = Number.isFinite(coolExcessHyst) ? coolExcessHyst : 0.2;
        const PRICE_ON = Number.isFinite(coolPriceLimit) ? coolPriceLimit : 50;
        const PRICE_OFF = PRICE_ON + (Number.isFinite(coolPriceHyst) ? coolPriceHyst : 5);

        let excludeRooms = [];
        try {
            const rawEx = (config.excludeRooms || "WG_air").trim();
            if (rawEx.startsWith("[")) {
                excludeRooms = JSON.parse(rawEx);
            } else {
                excludeRooms = rawEx.split(/[\s,]+/).filter(Boolean);
            }
        } catch (e) {
            excludeRooms = ["WG_air"];
        }
        const excludeSet = new Set(excludeRooms);

        let roomToFowMap = DEFAULT_ROOM_FOW_MAP;
        try {
            const rawMap = (config.roomToFowMap || "").trim();
            if (rawMap) {
                roomToFowMap = JSON.parse(rawMap);
            }
        } catch (e) {
            node.warn(`[room-overheat-checker] invalid roomToFowMap JSON, using defaults: ${e.message}`);
        }

        const allFowTopics = [];
        const fowTopicSet = new Set();
        for (const topics of Object.values(roomToFowMap)) {
            if (!Array.isArray(topics)) continue;
            for (const t of topics) {
                const topic = String(t).trim();
                if (topic && !fowTopicSet.has(topic)) {
                    fowTopicSet.add(topic);
                    allFowTopics.push(topic);
                }
            }
        }

        let spotPrice = null;
        let forceHeat = 0;
        let forceCool = 0;
        let priceOk = false;
        const roomState = {};   // roomName -> 0|1
        const autoFowActive = {};  // FOW.n -> bool (we set it)

        node.log(
            `[room-overheat-checker] init E_ref=${E_REF} h=${HYS} price<${PRICE_ON} ` +
            `exclude=${[...excludeSet].join(",")} fowTopics=${allFowTopics.length}`
        );

        function readRoomForecasts() {
            const g = node.context().global.get("roomForecasts");
            if (g && typeof g === "object" && Object.keys(g).length > 0) {
                return g;
            }
            return node.context().flow.get("roomForecasts") || {};
        }

        function maxForecastExcess(room) {
            if (!room.Ti_forecast_noHeat || !Array.isArray(room.Ti_forecast_noHeat)) {
                return null;
            }
            const tset = Number(room.Tset);
            if (!Number.isFinite(tset)) return null;
            let maxEx = -Infinity;
            for (const ti of room.Ti_forecast_noHeat) {
                const v = Number(ti);
                if (!Number.isFinite(v)) continue;
                const ex = v - tset;
                if (ex > maxEx) maxEx = ex;
            }
            return maxEx === -Infinity ? null : maxEx;
        }

        function updatePriceOk() {
            if (spotPrice == null || !Number.isFinite(spotPrice)) {
                return;
            }
            if (!priceOk && spotPrice < PRICE_ON) {
                priceOk = true;
            } else if (priceOk && spotPrice > PRICE_OFF) {
                priceOk = false;
            }
        }

        function checkOverheat() {
            if (forceHeat || forceCool) {
                const msgs = [];
                if (enableAutoFow) {
                    for (const topic of allFowTopics) {
                        if (autoFowActive[topic]) {
                            autoFowActive[topic] = 0;
                            msgs.push({ topic, payload: 0 });
                        }
                    }
                }
                node.context().flow.set("coolingRequired", 0);
                if (coolingRequiredTopic) {
                    msgs.push({ topic: coolingRequiredTopic, payload: 0 });
                }
                if (outputTopic) {
                    msgs.push({ topic: outputTopic, payload: 0 });
                }
                if (msgs.length > 0) {
                    node.send(msgs);
                }
                node.status({
                    fill: "grey",
                    shape: "ring",
                    text: forceCool ? "HCMW force cool (auto idle)" : "HCMW force heat"
                });
                return;
            }

            updatePriceOk();

            const roomForecasts = readRoomForecasts();
            const now = Date.now();
            const hotRooms = [];
            let anyHot = false;

            for (const [roomName, roomData] of Object.entries(roomForecasts)) {
                if (!roomData || !roomData.healthy) continue;
                if ((now - roomData.timestamp) > staleThresholdMs) continue;
                if (excludeSet.has(roomName)) continue;
                if (!roomToFowMap[roomName]) continue;

                const tset = Number(roomData.Tset);
                const ti = Number(roomData.Ti_now);
                if (!Number.isFinite(tset) || !Number.isFinite(ti)) continue;

                const excess = ti - tset;
                const prev = roomState[roomName] ? 1 : 0;
                let next = prev;

                if (prev === 0) {
                    const forecastEx = maxForecastExcess(roomData);
                    const forecastHot = forecastEx != null && forecastEx > (E_REF + HYS);
                    const nowHot = excess > (E_REF + HYS);
                    if (nowHot || forecastHot) {
                        next = 1;
                    }
                } else if (excess < (E_REF - HYS)) {
                    next = 0;
                }

                roomState[roomName] = next;
                if (next) {
                    anyHot = true;
                    hotRooms.push({
                        name: roomName,
                        Ti: ti,
                        Tset: tset,
                        excess: excess
                    });
                }
            }

            const coolingRequired = priceOk && anyHot ? 1 : 0;
            node.context().flow.set("coolingRequired", coolingRequired);

            const msgs = [];
            if (coolingRequiredTopic) {
                msgs.push({ topic: coolingRequiredTopic, payload: coolingRequired });
            }
            if (outputTopic) {
                msgs.push({ topic: outputTopic, payload: coolingRequired });
            }

            if (enableAutoFow) {
                const wantFow = new Set();
                if (coolingRequired) {
                    for (const r of hotRooms) {
                        const topics = roomToFowMap[r.name] || [];
                        for (const t of topics) {
                            wantFow.add(t);
                        }
                    }
                }

                for (const topic of allFowTopics) {
                    const want = wantFow.has(topic) ? 1 : 0;
                    const wasAuto = autoFowActive[topic] ? 1 : 0;
                    if (want !== wasAuto) {
                        autoFowActive[topic] = want;
                        msgs.push({ topic, payload: want });
                    }
                }
            }

            if (msgs.length > 0) {
                node.send(msgs);
            }

            const priceStr = spotPrice != null && Number.isFinite(spotPrice)
                ? spotPrice.toFixed(1)
                : "n/a";
            if (coolingRequired) {
                const names = hotRooms.map(r => `${r.name}(${r.excess.toFixed(1)})`).join(" ");
                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: `COOL ${hotRooms.length}r p=${priceStr} ${names} (${ts.formatStatus()})`
                });
                node.log(
                    `[room-overheat-checker] COOL ON rooms=${hotRooms.length} price=${priceStr} ` +
                    hotRooms.map(r => `${r.name} e=${r.excess.toFixed(1)}`).join(" ")
                );
            } else if (anyHot && !priceOk) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: `hot wait price p=${priceStr} (${ts.formatStatus()})`
                });
            } else {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: `idle p=${priceStr} (${ts.formatStatus()})`
                });
            }
        }

        setTimeout(() => checkOverheat(), 15000);
        const periodicInterval = setInterval(() => checkOverheat(), 5 * 60 * 1000);

        node.on("input", (msg) => {
            const t = String(msg.topic || "").trim();
            if (spotPriceTopic && t === spotPriceTopic) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (v !== null) {
                    spotPrice = v;
                    updatePriceOk();
                }
            } else if (hcmwForceHeatTopic && t === hcmwForceHeatTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                forceHeat = bit;
            } else if (hcmwForceCoolTopic && t === hcmwForceCoolTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                forceCool = bit;
            }
            checkOverheat();
        });

        node.on("close", () => {
            clearInterval(periodicInterval);
        });
    }

    RED.nodes.registerType("uniflex-room-overheat-checker", RoomOverheatCheckerNode);
};
