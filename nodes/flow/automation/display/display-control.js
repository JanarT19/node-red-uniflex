const ts = require("../../core/lib/timestamp.js");
// uniflex-display-control.js
// Node-RED node: uniflex-display-control
// Purpose: UF8711-style dual-line display: DRW row values + DCW blink/blank/decimal bits.
// Writes only when a value deviates from wanted (blind write of all wanted values on init).

module.exports = function (RED) {
    function DisplayControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.levelTopic = (config.levelTopic || "").trim();
        node.levelLoTopic = (config.levelLoTopic || "").trim();
        node.levelHiTopic = (config.levelHiTopic || "").trim();
        node.currentTopic = (config.currentTopic || "").trim();
        node.drwRow1Topic = (config.drwRow1Topic || "").trim();
        node.drwRow2Topic = (config.drwRow2Topic || "").trim();
        node.dcwBlinkRow1Topic = (config.dcwBlinkRow1Topic || "").trim();
        node.dcwBlankRow1Topic = (config.dcwBlankRow1Topic || "").trim();
        node.dcwBlinkRow2Topic = (config.dcwBlinkRow2Topic || "").trim();
        node.dcwBlankRow2Topic = (config.dcwBlankRow2Topic || "").trim();
        node.dcwDecimalRow1Topic = (config.dcwDecimalRow1Topic || "").trim();
        node.dcwDecimalRow2Topic = (config.dcwDecimalRow2Topic || "").trim();

        node.levelScale = Number(config.levelScale ?? 100);
        node.currentScale = Number(config.currentScale ?? 10);
        node.levelLo = Number(config.levelLo ?? 0.2);
        node.levelHi = Number(config.levelHi ?? 1.0);
        node.currentBlankThreshold = Number(config.currentBlankThreshold ?? 0.2);
        node.currentHiLimit = Number(config.currentHiLimit ?? 10.0);
        node.enableSystemLog = config.enableSystemLog === true;

        if (!Number.isFinite(node.levelScale) || node.levelScale <= 0) {
            node.warn("levelScale invalid, using 100");
            node.levelScale = 100;
        }
        if (!Number.isFinite(node.currentScale) || node.currentScale <= 0) {
            node.warn("currentScale invalid, using 10");
            node.currentScale = 10;
        }

        let levelActual = null;
        let levelLoLive = null;
        let levelHiLive = null;
        let currentActual = null;
        const lastWritten = Object.create(null);

        function extractValue(payload) {
            if (Array.isArray(payload)) {
                return payload[0];
            }
            return payload;
        }

        function toNumber(value) {
            if (value === null || value === undefined || value === "") {
                return null;
            }
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        }

        function systemLog(message) {
            if (node.enableSystemLog) {
                node.log(message);
            }
        }

        function scaleLevel(m) {
            if (m === null) {
                return null;
            }
            return Math.round(m * node.levelScale);
        }

        function scaleCurrent(a) {
            if (a === null) {
                return null;
            }
            return Math.round(a * node.currentScale);
        }

        function resolveLevelLo() {
            if (levelLoLive !== null) {
                return levelLoLive;
            }
            if (node.levelLoTopic) {
                return null;
            }
            return Number.isFinite(node.levelLo) ? node.levelLo : null;
        }

        function resolveLevelHi() {
            if (levelHiLive !== null) {
                return levelHiLive;
            }
            if (node.levelHiTopic) {
                return null;
            }
            return Number.isFinite(node.levelHi) ? node.levelHi : null;
        }

        function levelLimitsReady() {
            const lo = resolveLevelLo();
            const hi = resolveLevelHi();
            return lo !== null && hi !== null && lo <= hi;
        }

        function row1Blink() {
            if (!node.dcwBlinkRow1Topic || levelActual === null || !levelLimitsReady()) {
                return null;
            }
            const lo = resolveLevelLo();
            const hi = resolveLevelHi();
            return levelActual < lo || levelActual > hi ? 1 : 0;
        }

        function row2Blank() {
            if (!node.dcwBlankRow2Topic || currentActual === null) {
                return null;
            }
            return currentActual < node.currentBlankThreshold ? 1 : 0;
        }

        function row2Blink() {
            if (!node.dcwBlinkRow2Topic || currentActual === null) {
                return null;
            }
            return currentActual > node.currentHiLimit ? 1 : 0;
        }

        function setOutput(out, topic, value) {
            if (topic && value !== null && value !== undefined) {
                out[topic] = value | 0;
            }
        }

        function wantedOutputs() {
            const out = Object.create(null);

            if (node.drwRow1Topic && levelActual !== null) {
                setOutput(out, node.drwRow1Topic, scaleLevel(levelActual));
            }
            if (node.drwRow2Topic && currentActual !== null) {
                setOutput(out, node.drwRow2Topic, scaleCurrent(currentActual));
            }
            setOutput(out, node.dcwBlinkRow1Topic, row1Blink());
            if (node.dcwBlankRow1Topic) {
                setOutput(out, node.dcwBlankRow1Topic, 0);
            }
            setOutput(out, node.dcwBlinkRow2Topic, row2Blink());
            setOutput(out, node.dcwBlankRow2Topic, row2Blank());
            if (node.dcwDecimalRow1Topic) {
                setOutput(out, node.dcwDecimalRow1Topic, 1);
            }
            if (node.dcwDecimalRow2Topic) {
                setOutput(out, node.dcwDecimalRow2Topic, 1);
            }

            return out;
        }

        function queueWrite(topic, value, force) {
            if (!topic) {
                return null;
            }
            const prev = lastWritten[topic];
            if (!force && prev === value) {
                return null;
            }
            lastWritten[topic] = value;
            return { topic, payload: value };
        }

        function syncOutputs(forceAll) {
            const wanted = wantedOutputs();
            const msgs = [];

            for (const topic of Object.keys(wanted)) {
                const msg = queueWrite(topic, wanted[topic], forceAll);
                if (msg) {
                    msgs.push(msg);
                }
            }

            if (msgs.length > 0) {
                // outputs=1: node.send([msg1, msg2]) drops msg2; wrap array for same output
                node.send([msgs]);
                if (node.enableSystemLog) {
                    systemLog(
                        (forceAll ? "init write: " : "changed: ") +
                            msgs.map((m) => `${m.topic}=${m.payload}`).join(", ")
                    );
                }
            }

            updateStatus();
        }

        function updateStatus() {
            const parts = [];

            if (levelActual !== null) {
                parts.push(`L=${levelActual.toFixed(3)}`);
                if (node.drwRow1Topic) {
                    parts.push(`R1=${scaleLevel(levelActual)}`);
                }
            }
            if (currentActual !== null) {
                parts.push(`I=${currentActual.toFixed(2)}A`);
                if (node.drwRow2Topic) {
                    parts.push(`R2=${scaleCurrent(currentActual)}`);
                }
            }

            if (levelLimitsReady()) {
                parts.push(`lim=[${resolveLevelLo()},${resolveLevelHi()}]`);
            } else if (node.dcwBlinkRow1Topic) {
                parts.push("lim=?");
            }

            if (parts.length === 0) {
                node.status({ fill: "grey", shape: "ring", text: "waiting for inputs" });
                return;
            }

            const flags = [];
            const b1 = row1Blink();
            if (b1 === 1) {
                flags.push("R1blink");
            }
            if (row2Blank() === 1) {
                flags.push("R2blank");
            }
            if (row2Blink() === 1) {
                flags.push("R2blink");
            }
            if (flags.length > 0) {
                parts.push(flags.join(","));
            }

            node.status({ fill: "blue", shape: "dot", text: parts.join(" ") });
        }

        function blindInitWrite() {
            syncOutputs(true);
        }

        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = extractValue(msg.payload);
            let touched = false;

            if (node.levelTopic && t === node.levelTopic) {
                const val = toNumber(p);
                if (val !== null) {
                    levelActual = val;
                    touched = true;
                }
            }

            if (node.levelLoTopic && t === node.levelLoTopic) {
                const val = toNumber(p);
                if (val !== null) {
                    levelLoLive = val;
                    touched = true;
                }
            }

            if (node.levelHiTopic && t === node.levelHiTopic) {
                const val = toNumber(p);
                if (val !== null) {
                    levelHiLive = val;
                    touched = true;
                }
            }

            if (node.currentTopic && t === node.currentTopic) {
                const val = toNumber(p);
                if (val !== null) {
                    currentActual = val;
                    touched = true;
                }
            }

            if (touched) {
                syncOutputs(false);
            }
        });

        node.on("close", () => {
            node.status({});
        });

        updateStatus();
        setTimeout(() => {
            blindInitWrite();
        }, 200);
    }

    RED.nodes.registerType("uniflex-display-control", DisplayControlNode);
};
