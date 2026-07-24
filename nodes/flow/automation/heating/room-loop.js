const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function RoomLoopNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name;

        node.globalTickTopic = config.globalTickTopic; // required
        node.roomTickTopic = config.roomTickTopic;

        node.tickDelaySec = Number(config.tickDelaySec ?? 0);

        node.tRoomTopic = config.tRoomTopic;
        node.spRoomTopic = config.spRoomTopic;
        node.tRetOut = config.tRetOut;

        node.errorTopic = (config.errorTopic || "").trim();

        node.Kp = Number(config.Kp ?? 1.0);
        node.Ii = Number(config.Ii ?? 0.0);
        node.Dd = Number(config.Dd ?? 0.0);

        node.outClampLow = Number(config.outClampLow ?? 0.0);
        node.outClampHigh = Number(config.outClampHigh ?? 1.0);

        // persistence
        node.persistencePath = config.persistencePath;

        // ---- STATE
        const ITERATION_GATE_MS = 30000;

        let lastGlobalTickTsSec = null;
        let lastPeriodSec = null;
        let lastIterationTime = 0;
        let lastError = null; // Store last calculated error for publishing

        // Validation constants
        const invalidValues = ["", null, undefined];

        setStatus(`Ready - waiting for global tick: ${node.globalTickTopic || "n/a"}`, "grey");

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        // ---- Eager PI init (ignore cooling entirely)
        (function initPI() {
            try {
                const { createPI } = require("./pi-core");

                const pi = createPI({
                    Kp: node.Kp,
                    Ii: node.Ii,
                    invert: false,
                    outClampLow: node.outClampLow,
                    outClampHigh: node.outClampHigh
                });

                if (!pi || typeof pi.step !== "function") {
                    node.debug(`createPI() did not return a full API at ${require("path").join(__dirname, "pi-core.js")}`);
                    node._pi = null;
                    return;
                }

                node._pi = pi;

                if (node.persistencePath && typeof node._pi.setPersistenceFile === "function") {
                    const _pfx = "room-loop";
                    const _safe = (node.name || node.id || "unknown").replace(/\s+/g, "-");
                    const _stem = _safe === _pfx || _safe.startsWith(_pfx + "-") ? _safe : `${_pfx}-${_safe}`;
                    node._pi.setPersistenceFile(`${node.persistencePath}/${_stem}.json`);
                }
                if (typeof node._pi.setPersistenceMode === "function") node._pi.setPersistenceMode("external"); // room loop saves on tick only
                if (typeof node._pi.loadState === "function") {
                    const ok = node._pi.loadState();
                    node.log(`[room-loop:${node.name || node.id}] PI ready. ${ok ? `preloaded I=${node._pi.getIntegral().toFixed(4)}` : "no preload"}`);
                }
            } catch (e) {
                node.error(`PI init failed: ${e.message}`);
            }
        })();

        function publishRoomTick(msg) {
            const tsNowSec = Math.floor(Date.now() / 1000);
            const payload = { ts: tsNowSec, periodSec: Number(msg?.periodSec) };

            if (node._pi && typeof node._pi.saveState === "function") {
                node._pi.saveState();
                node.debug(`PI state saved on room tick`);
            }

            node.send({ topic: node.roomTickTopic, payload });

            // Publish error if error topic is configured and we have a valid error value
            if (node.errorTopic && lastError !== null && typeof lastError === "number") {
                const errorMsg = { topic: node.errorTopic, payload: Number(lastError.toFixed(4)) };
                node.send(errorMsg);
                node.warn(`[room-loop:${node.name || node.id}] Published error message - topic: "${node.errorTopic}", payload: ${errorMsg.payload}`);
            } else {
                node.debug(`[room-loop:${node.name || node.id}] Skipped error publish - errorTopic: ${node.errorTopic}, lastError: ${lastError}`);
            }

            setStatus(`Tick published (${ts.formatStatus()})`, "green");
        }

        function computeTretSp(roomT, roomSP) {
            if (!node._pi) {
                node.debug("PI not initialized yet");
                return null;
            }

            if (lastPeriodSec && typeof node._pi.setReferenceSample === "function") {
                node._pi.setReferenceSample(lastPeriodSec);
            }

            const e = Number(roomSP) - Number(roomT);
            lastError = e; // Store error for publishing on room tick

            const u = node._pi.step(e, { now: Date.now() / 1000 });
            node.debug(`computeTretSp: T=${roomT} SP=${roomSP} e=${e} -> u=${u}`);

            return u;
        }

        // ---- Input
        node.on("input", (msg) => {
            const t = msg.topic;

            // Basic validation

            // TODO: is name actually required, used by other nodes?
            if (node.name && /[\s#+\x00-\x1F\x7F]/.test(node.name)) {
                node.error(`[room-loop] Invalid name "${node.name}": contains forbidden topic characters (spaces, #, +, or control characters)`);
                node.status({ fill: "red", shape: "dot", text: `Invalid name` });
                return;
            }

            if (invalidValues.includes(node.globalTickTopic)) {
                node.error(`Global tick topic must be configured`);
                node.status({ fill: "red", shape: "dot", text: `Global tick topic not configured` });
                return;
            }

            if (invalidValues.includes(node.spRoomTopic)) {
                node.error(`Room setpoint topic must be configured`);
                node.status({ fill: "red", shape: "dot", text: `Room setpoint topic not configured` });
                return;
            }

            if (invalidValues.includes(node.tRoomTopic)) {
                node.error(`Room temperature topic must be configured`);
                node.status({ fill: "red", shape: "dot", text: `Room temperature topic not configured` });
                return;
            }

            // Global tick
            if (t === node.globalTickTopic) {
                const ts = msg.payload?.ts;
                const periodSec = Number(msg.payload?.periodSec);

                if (!ts || !periodSec) {
                    setStatus(`Invalid tick (${ts.formatStatus()})`, "red");
                    return;
                }

                if (lastGlobalTickTsSec !== ts) {
                    lastGlobalTickTsSec = ts;
                    lastPeriodSec = periodSec || lastPeriodSec;

                    setStatus(`Tick delayed until ${new Date().toLocaleTimeString()} (+${node.tickDelaySec}s)`, "blue");
                    setTimeout(() => publishRoomTick(msg.payload), Math.max(0, node.tickDelaySec * 1000));
                }
                return;
            }

            if (t === node.spRoomTopic) {
                node._lastRoomSP = Number(msg.payload);
                return;
            }

            if (t === node.tRoomTopic) {
                node._lastRoomT = Number(msg.payload);
                if (typeof node._lastRoomT === "number" && typeof node._lastRoomSP === "number" && node.tRetOut) {
                    const now = Date.now();

                    if (now - lastIterationTime < ITERATION_GATE_MS) return;

                    lastIterationTime = now;
                    const tret = computeTretSp(node._lastRoomT, node._lastRoomSP);

                    if (tret != null) {
                        node.send({ topic: node.tRetOut, payload: Number(tret.toFixed(2)) });
                        setStatus(`Last out: ${tret.toFixed(2)} (${new Date().toLocaleTimeString("en-GB", { hour12: false })})`, "blue");
                    }
                }

                return;
            }
        });
    }

    RED.nodes.registerType("uniflex-room-loop", RoomLoopNode);
};
