const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function LoopSupervisorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.recoveryBandAbsC = Number(config.recoveryBandAbsC ?? 1.5);
        node.maxForceSec = Number(config.maxForceSec ?? 3600);
        node.presenceTopic = config.presenceTopic || "heating/+/+/presence";
        node.roomErrorTopic = config.roomErrorTopic || "heating/+/room/error";
        node.roomTickTopic = config.roomTickTopic || "heating/+/tick";

        // loop registry: roomId: { loops: { loopId: { topics } }, lastTickTs }
        const registry = Object.create(null);
        // active forces: key -> { untilTs }
        const active = Object.create(null);

        function key(roomId, loopId) {
            return `${roomId}:${loopId}`;
        }

        function clearForcesForRoom(roomId) {
            const now = Math.floor(Date.now() / 1000);
            for (const k of Object.keys(active)) {
                if (k.startsWith(`${roomId}:`)) {
                    const entry = active[k];
                    if (entry && entry.topics) {
                        if (entry.topics.forceOpen) node.send({ topic: entry.topics.forceOpen, payload: 0 });
                        if (entry.topics.forceClose) node.send({ topic: entry.topics.forceClose, payload: 0 });
                    }
                    delete active[k];
                }
            }
            node.status({ fill: "grey", shape: "dot", text: `tick → clear forces @ ${now}` });
        }

        function forceLoop(roomId, loopId, dir, topics) {
            const untilTs = Math.floor(Date.now() / 1000) + node.maxForceSec;
            const k = key(roomId, loopId);
            active[k] = { untilTs, topics };
            if (dir > 0 && topics.forceOpen) {
                node.send({ topic: topics.forceOpen, payload: 1 });
                if (topics.forceClose) node.send({ topic: topics.forceClose, payload: 0 });
            } else if (dir < 0 && topics.forceClose) {
                node.send({ topic: topics.forceClose, payload: 1 });
                if (topics.forceOpen) node.send({ topic: topics.forceOpen, payload: 0 });
            }
        }

        function handlePresence(p) {
            const roomId = p.roomId || "";
            const loopId = p.loopId || "";
            if (!roomId || !loopId || !p.topics) return;
            if (!registry[roomId]) registry[roomId] = { loops: {} };
            registry[roomId].loops[loopId] = { topics: p.topics };
        }

        function handleRoomError(roomId, errorC) {
            if (!registry[roomId]) return;
            const band = Math.abs(node.recoveryBandAbsC);
            const dir = errorC >= band ? 1 : errorC <= -band ? -1 : 0;
            for (const [loopId, rec] of Object.entries(registry[roomId].loops)) {
                const k = key(roomId, loopId);
                if (dir === 0) continue;
                const now = Math.floor(Date.now() / 1000);
                const isActive = active[k] && active[k].untilTs > now;
                if (!isActive) forceLoop(roomId, loopId, dir, rec.topics);
            }
            node.status({ fill: dir !== 0 ? "yellow" : "grey", shape: "dot", text: `err=${errorC.toFixed(1)}°C` });
        }

        node.on("input", (msg) => {
            const t = msg.topic || "";
            if (t.endsWith("/presence") && msg.payload && typeof msg.payload === "object") {
                handlePresence(msg.payload);
                return;
            }
            // match room error wildcard: heating/<roomId>/room/error
            if (t.includes("/room/error")) {
                const parts = t.split("/");
                const roomId = parts[1] || "";
                const errorC = Number(msg.payload);
                if (!isNaN(errorC)) handleRoomError(roomId, errorC);
                return;
            }
            // match room tick: heating/<roomId>/tick
            if (t.endsWith("/tick")) {
                const parts = t.split("/");
                const roomId = parts[1] || "";
                clearForcesForRoom(roomId);
                return;
            }
            // expiry check (optional on any message)
            const now = Math.floor(Date.now() / 1000);
            for (const [k, v] of Object.entries(active)) {
                if (v.untilTs <= now) delete active[k];
            }
        });
    }
    RED.nodes.registerType("uniflex-loop-supervisor", LoopSupervisorNode);
};
