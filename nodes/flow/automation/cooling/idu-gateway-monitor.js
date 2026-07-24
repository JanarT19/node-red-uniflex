const http = require("http");
const ts = require("../../core/lib/timestamp.js");
const iduMap = require("./idu-gateway-map.js");

const IDU_GATEWAY_MONITOR_VERSION = "1.4.1";
const IDU_SLOT_COUNT = 64;
const SNAPSHOT_TOPIC = "idu-gateway/snapshot";
const GATEWAY_IDU_COUNT = 54;

function isUnknownValue(v) {
    return v === null;
}

function decodeIduByte(byteVal) {
    if ((byteVal & 0x04) === 0) {
        return { v: null };
    }
    if ((byteVal & 0x02) !== 0) {
        return { v: null };
    }
    if ((byteVal & 0x01) !== 0) {
        return { v: 1 };
    }
    return { v: 0 };
}

function parseInunitDiscrete(hexStr) {
    const out = [];
    const raw = String(hexStr || "").trim();
    for (let i = 0; i < IDU_SLOT_COUNT; i += 1) {
        const pair = raw.substr(i * 2, 2);
        if (pair.length < 2) {
            out.push({ v: null });
            continue;
        }
        const byteVal = parseInt(pair, 16);
        if (!Number.isFinite(byteVal)) {
            out.push({ v: null });
            continue;
        }
        out.push(decodeIduByte(byteVal));
    }
    return out;
}

function summarizeStates(iduStates) {
    let online = 0;
    let active = 0;
    let offline = 0;
    for (let i = 0; i < GATEWAY_IDU_COUNT; i += 1) {
        const st = iduStates[i];
        if (!st) {
            offline += 1;
            continue;
        }
        if (isUnknownValue(st.v)) {
            offline += 1;
        } else {
            online += 1;
            if (st.v === 1) {
                active += 1;
            }
        }
    }
    return { online, active, offline };
}

function buildStatesByIdu(iduStates) {
    const out = {};
    for (let i = 0; i < GATEWAY_IDU_COUNT; i += 1) {
        const st = iduStates[i] || { v: null };
        out[String(i + 1)] = st.v;
    }
    return out;
}

module.exports = function (RED) {
    if (RED.httpAdmin && !RED.httpAdmin._uniflexIduGatewayStateRoute) {
        RED.httpAdmin._uniflexIduGatewayStateRoute = true;
        RED.httpAdmin.get("/uniflex/idu-gateway-monitor/:id/state", function (req, res) {
            const node = RED.nodes.getNode(req.params.id);
            if (!node || node.type !== "uniflex-idu-gateway-monitor") {
                res.status(404).json({ error: "node not found" });
                return;
            }
            if (typeof node.getPollState !== "function") {
                res.json({ summary: null, rows: [], ts: null });
                return;
            }
            res.json(node.getPollState());
        });
    }

    function IduGatewayMonitorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const tag = `[idu-gateway-monitor:${node.name || "unnamed"}]`;

        node.name = config.name || "";
        node.gatewayHost = (config.gatewayHost || "192.168.2.200").trim();
        node.pathSuffix = String(config.pathSuffix || "888").trim();
        node.pollSec = Math.max(15, Number(config.pollSec ?? 120));
        node.timeoutMs = Math.max(3000, Number(config.timeoutMs ?? 15000));
        node.enableDebug = config.enableDebug === true;
        node.mapRows = iduMap.normalizeMapRows(config.mapRows || []);
        node.lastPollState = null;

        node.getPollState = function () {
            return node.lastPollState || { summary: null, rows: [], statesByIdu: {}, ts: null };
        };

        let pollTimer = null;
        let pollInFlight = false;

        function dbg(msg) {
            if (node.enableDebug) {
                node.log(`${tag} ${msg}`);
            }
        }

        function buildSnapshotMessage(iduStates) {
            return {
                topic: SNAPSHOT_TOPIC,
                payload: iduMap.buildMappedSnapshot(node.mapRows, iduStates)
            };
        }

        function postGateway() {
            return new Promise((resolve, reject) => {
                const path = `/get_mbdata_all.jsn/${node.pathSuffix}`;
                const body = "_web_cmd=get_mbdata_all&_ajax=1";
                const req = http.request(
                    {
                        host: node.gatewayHost,
                        port: 80,
                        path: path,
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded",
                            "Content-Length": Buffer.byteLength(body),
                            Accept: "application/json"
                        },
                        timeout: node.timeoutMs
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (chunk) => {
                            data += chunk;
                        });
                        res.on("end", () => {
                            if (res.statusCode !== 200) {
                                reject(new Error(`HTTP ${res.statusCode}`));
                                return;
                            }
                            try {
                                resolve(JSON.parse(data));
                            } catch (err) {
                                reject(new Error(`invalid JSON: ${err.message}`));
                            }
                        });
                    }
                );
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("request timeout"));
                });
                req.on("error", reject);
                req.write(body);
                req.end();
            });
        }

        function emitSnapshot(iduStates, summaryText) {
            const snapshot = buildSnapshotMessage(iduStates);
            node.lastPollState = {
                summary: {
                    online: summaryText.online,
                    active: summaryText.active,
                    offline: summaryText.offline,
                    text: summaryText.text
                },
                rows: snapshot.payload,
                statesByIdu: buildStatesByIdu(iduStates),
                ts: Date.now()
            };
            if (RED.events && typeof RED.events.emit === "function") {
                try {
                    RED.events.emit("runtime-event", {
                        id: "idu-gateway-monitor-state-" + node.id,
                        payload: node.lastPollState,
                        retain: true
                    });
                } catch (err) {
                    if (node.enableDebug) {
                        node.warn(`${tag} editor state push failed: ${err.message}`);
                    }
                }
            }
            node.status({
                fill: summaryText.offline > 0 ? "yellow" : "green",
                shape: "dot",
                text: summaryText.text
            });
            node.send(snapshot);
            if (node.enableDebug) {
                const sample = snapshot.payload
                    .filter((row) => row.stream && row.v === 1)
                    .slice(0, 5)
                    .map((row) => row.label)
                    .join(", ");
                if (sample) {
                    dbg(`active sample: ${sample}`);
                }
            }
        }

        function allUnknownStates() {
            return new Array(IDU_SLOT_COUNT).fill(null).map(() => ({ v: null }));
        }

        async function runPoll(trigger) {
            if (pollInFlight) {
                dbg(`skip poll (${trigger}): previous still running`);
                return;
            }
            if (!node.mapRows.length) {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "map empty: configure IDU rows"
                });
                node.warn(`${tag} poll skipped (${trigger}): mapRows empty`);
                return;
            }
            pollInFlight = true;
            try {
                const json = await postGateway();
                if (!json || json.status !== "ok" || !json.inunit_discrete) {
                    throw new Error("gateway response missing inunit_discrete");
                }
                const iduStates = parseInunitDiscrete(json.inunit_discrete);
                const summary = summarizeStates(iduStates);
                const text = `IDU online ${summary.online}/${GATEWAY_IDU_COUNT} active ${summary.active}`;
                dbg(`${trigger}: ${text}`);
                emitSnapshot(iduStates, {
                    online: summary.online,
                    active: summary.active,
                    offline: summary.offline,
                    text: text
                });
            } catch (err) {
                node.warn(`${tag} poll failed (${trigger}): ${err.message}`);
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: `gateway error: ${err.message}`
                });
                emitSnapshot(allUnknownStates(), {
                    online: 0,
                    active: 0,
                    offline: GATEWAY_IDU_COUNT,
                    text: "gateway unreachable, all unknown"
                });
            } finally {
                pollInFlight = false;
            }
        }

        function schedulePollTimer() {
            if (pollTimer) {
                clearInterval(pollTimer);
            }
            pollTimer = setInterval(() => {
                runPoll("timer");
            }, node.pollSec * 1000);
        }

        node.on("input", (msg, send, done) => {
            runPoll(msg && msg.topic ? `input:${msg.topic}` : "input")
                .then(() => done())
                .catch((err) => done(err));
        });

        node.on("close", () => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        });

        schedulePollTimer();
        setTimeout(() => {
            runPoll("startup");
        }, 2000);

        if (!node.mapRows.length) {
            node.warn(`${tag} mapRows empty - open node and load IDU mapping table`);
        }
        node.log(`${tag} v${IDU_GATEWAY_MONITOR_VERSION} host ${node.gatewayHost} poll ${node.pollSec}s map ${node.mapRows.length} idus`);
    }

    RED.nodes.registerType("uniflex-idu-gateway-monitor", IduGatewayMonitorNode, {
        version: IDU_GATEWAY_MONITOR_VERSION
    });
};
