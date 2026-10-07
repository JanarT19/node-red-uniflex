const net = require("net");
const ts = require("../../core/lib/timestamp.js");
const MANIFEST = [
  {
    "flat": "201",
    "key": "SBN201W",
    "zones": 3
  },
  {
    "flat": "202",
    "key": "SAN202W",
    "zones": 2
  },
  {
    "flat": "203",
    "key": "SAN203W",
    "zones": 2
  },
  {
    "flat": "204",
    "key": "SAN204W",
    "zones": 2
  },
  {
    "flat": "205",
    "key": "SAN205W",
    "zones": 2
  },
  {
    "flat": "206",
    "key": "SAC206W",
    "zones": 2
  },
  {
    "flat": "207",
    "key": "SAC207W",
    "zones": 2
  },
  {
    "flat": "208",
    "key": "SAC208W",
    "zones": 2
  },
  {
    "flat": "209",
    "key": "SAC209W",
    "zones": 2
  },
  {
    "flat": "210",
    "key": "SBN210W",
    "zones": 3
  },
  {
    "flat": "211",
    "key": "SAN211W",
    "zones": 2
  },
  {
    "flat": "212",
    "key": "SBN212W",
    "zones": 3
  },
  {
    "flat": "301",
    "key": "SBN301W",
    "zones": 3
  },
  {
    "flat": "302",
    "key": "SAN302W",
    "zones": 2
  },
  {
    "flat": "303",
    "key": "SAN303W",
    "zones": 2
  },
  {
    "flat": "304",
    "key": "SAN304W",
    "zones": 2
  },
  {
    "flat": "305",
    "key": "SAN305W",
    "zones": 2
  },
  {
    "flat": "306",
    "key": "SAC306W",
    "zones": 2
  },
  {
    "flat": "307",
    "key": "SAC307W",
    "zones": 2
  },
  {
    "flat": "308",
    "key": "SAC308W",
    "zones": 2
  },
  {
    "flat": "309",
    "key": "SAC309W",
    "zones": 2
  },
  {
    "flat": "310",
    "key": "SAC310W",
    "zones": 2
  },
  {
    "flat": "311",
    "key": "SAC311W",
    "zones": 2
  },
  {
    "flat": "312",
    "key": "SBC312W",
    "zones": 3
  },
  {
    "flat": "313",
    "key": "SBN313W",
    "zones": 3
  },
  {
    "flat": "314",
    "key": "SAN314W",
    "zones": 2
  },
  {
    "flat": "315",
    "key": "SBN315W",
    "zones": 3
  },
  {
    "flat": "401",
    "key": "SBN401W",
    "zones": 3
  },
  {
    "flat": "402",
    "key": "SAN402W",
    "zones": 2
  },
  {
    "flat": "403",
    "key": "SAN403W",
    "zones": 2
  },
  {
    "flat": "404",
    "key": "SAN404W",
    "zones": 2
  },
  {
    "flat": "405",
    "key": "SAN405W",
    "zones": 2
  },
  {
    "flat": "406",
    "key": "SAC406W",
    "zones": 2
  },
  {
    "flat": "407",
    "key": "SAC407W",
    "zones": 2
  },
  {
    "flat": "408",
    "key": "SAC408W",
    "zones": 2
  },
  {
    "flat": "409",
    "key": "SAC409W",
    "zones": 2
  },
  {
    "flat": "410",
    "key": "SAC410W",
    "zones": 2
  },
  {
    "flat": "411",
    "key": "SAC411W",
    "zones": 2
  },
  {
    "flat": "412",
    "key": "SBC412W",
    "zones": 3
  },
  {
    "flat": "413",
    "key": "SBN413W",
    "zones": 3
  },
  {
    "flat": "414",
    "key": "SAN414W",
    "zones": 2
  },
  {
    "flat": "415",
    "key": "SBN415W",
    "zones": 3
  },
  {
    "flat": "501",
    "key": "SBN501W",
    "zones": 3
  },
  {
    "flat": "502",
    "key": "SAN502W",
    "zones": 2
  },
  {
    "flat": "503",
    "key": "SAN503W",
    "zones": 2
  },
  {
    "flat": "504",
    "key": "SAN504W",
    "zones": 2
  },
  {
    "flat": "505",
    "key": "SAN505W",
    "zones": 2
  },
  {
    "flat": "506",
    "key": "SAC506W",
    "zones": 2
  },
  {
    "flat": "507",
    "key": "SAC507W",
    "zones": 2
  },
  {
    "flat": "508",
    "key": "SAC508W",
    "zones": 2
  },
  {
    "flat": "509",
    "key": "SAC509W",
    "zones": 2
  },
  {
    "flat": "510",
    "key": "SAC510W",
    "zones": 2
  },
  {
    "flat": "511",
    "key": "SAC511W",
    "zones": 2
  },
  {
    "flat": "512",
    "key": "SBC512W",
    "zones": 3
  },
  {
    "flat": "513",
    "key": "SBN513W",
    "zones": 3
  },
  {
    "flat": "514",
    "key": "SAN514W",
    "zones": 2
  },
  {
    "flat": "515",
    "key": "SBN515W",
    "zones": 3
  },
  {
    "flat": "601",
    "key": "SBN601W",
    "zones": 3
  },
  {
    "flat": "602",
    "key": "SAN602W",
    "zones": 2
  },
  {
    "flat": "603",
    "key": "SAN603W",
    "zones": 2
  },
  {
    "flat": "604",
    "key": "SAN604W",
    "zones": 2
  },
  {
    "flat": "605",
    "key": "SAN605W",
    "zones": 2
  },
  {
    "flat": "606",
    "key": "SAC606W",
    "zones": 2
  },
  {
    "flat": "607",
    "key": "SAC607W",
    "zones": 2
  },
  {
    "flat": "608",
    "key": "SAC608W",
    "zones": 2
  },
  {
    "flat": "609",
    "key": "SAC609W",
    "zones": 2
  },
  {
    "flat": "610",
    "key": "SAC610W",
    "zones": 2
  },
  {
    "flat": "611",
    "key": "SAC611W",
    "zones": 2
  },
  {
    "flat": "612",
    "key": "SBC612W",
    "zones": 3
  },
  {
    "flat": "613",
    "key": "SBN613W",
    "zones": 3
  },
  {
    "flat": "614",
    "key": "SAN614W",
    "zones": 2
  },
  {
    "flat": "615",
    "key": "SBN615W",
    "zones": 3
  },
  {
    "flat": "701",
    "key": "SBN701W",
    "zones": 3
  },
  {
    "flat": "702",
    "key": "SAN702W",
    "zones": 2
  },
  {
    "flat": "703",
    "key": "SAN703W",
    "zones": 2
  },
  {
    "flat": "704",
    "key": "SAN704W",
    "zones": 2
  },
  {
    "flat": "705",
    "key": "SAN705W",
    "zones": 2
  },
  {
    "flat": "706",
    "key": "SAC706W",
    "zones": 2
  },
  {
    "flat": "707",
    "key": "SAC707W",
    "zones": 2
  },
  {
    "flat": "708",
    "key": "SAC708W",
    "zones": 2
  },
  {
    "flat": "709",
    "key": "SAC709W",
    "zones": 2
  },
  {
    "flat": "710",
    "key": "SAC710W",
    "zones": 2
  },
  {
    "flat": "711",
    "key": "SAC711W",
    "zones": 2
  },
  {
    "flat": "712",
    "key": "SBC712W",
    "zones": 3
  },
  {
    "flat": "713",
    "key": "SBN713W",
    "zones": 3
  },
  {
    "flat": "714",
    "key": "SAN714W",
    "zones": 2
  },
  {
    "flat": "715",
    "key": "SBN715W",
    "zones": 3
  },
  {
    "flat": "801",
    "key": "SBN801W",
    "zones": 3
  },
  {
    "flat": "802",
    "key": "SAN802W",
    "zones": 2
  },
  {
    "flat": "803",
    "key": "SAN803W",
    "zones": 2
  },
  {
    "flat": "804",
    "key": "SAN804W",
    "zones": 2
  },
  {
    "flat": "805",
    "key": "SAN805W",
    "zones": 2
  },
  {
    "flat": "806",
    "key": "SAC806W",
    "zones": 2
  },
  {
    "flat": "807",
    "key": "SAC807W",
    "zones": 2
  },
  {
    "flat": "808",
    "key": "SAC808W",
    "zones": 2
  },
  {
    "flat": "809",
    "key": "SAC809W",
    "zones": 2
  },
  {
    "flat": "810",
    "key": "SAC810W",
    "zones": 2
  },
  {
    "flat": "811",
    "key": "SAC811W",
    "zones": 2
  },
  {
    "flat": "812",
    "key": "SBC812W",
    "zones": 3
  },
  {
    "flat": "813",
    "key": "SBN813W",
    "zones": 3
  },
  {
    "flat": "814",
    "key": "SAN814W",
    "zones": 2
  },
  {
    "flat": "815",
    "key": "SBN815W",
    "zones": 3
  }
];

const THERMOKON_GLOBAL_SP_VERSION = "1.0.4";
const TGSW_TOPICS = ["TGSW.1", "TGSW.2", "TGSW.3"];
const DIFF_EPS = 0.05;
const TGSW_FANOUT_DEBOUNCE_MS = 100;

function tripletMember(zoneIndex, slot) {
    return zoneIndex * 3 + slot + 1;
}

function buildTargets() {
    const out = [];
    for (let i = 0; i < MANIFEST.length; i++) {
        const row = MANIFEST[i];
        const key = row.key;
        const zones = row.zones;
        for (let z = 0; z < zones; z++) {
            out.push({
                flat: row.flat,
                key: key,
                zone: z,
                eco: `${key}.${tripletMember(z, 0)}`,
                lo: `${key}.${tripletMember(z, 1)}`,
                hi: `${key}.${tripletMember(z, 2)}`
            });
        }
    }
    return out;
}

const TARGETS = buildTargets();
const SLOT_BY_TGSW = {
    "TGSW.1": "eco",
    "TGSW.2": "lo",
    "TGSW.3": "hi"
};

module.exports = function (RED) {
    function ThermokonGlobalSpNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const tag = `[thermokon-global-sp:${node.name || "unnamed"}]`;
        node.enableDebug = config.enableDebug === true;
        node.host = (config.host || "127.0.0.1").trim();
        node.tcpPort = parseInt(config.tcpPort, 10) || 19080;

        const readCache = Object.create(null);
        const tgswCache = Object.create(null);
        let tcpSocket = null;
        let tcpConnected = false;
        let tcpConnecting = false;
        let tcpReconnectTimer = null;
        let tcpReconnectDelayMs = 1000;
        let fanOutRunning = false;
        const pendingFanOut = [];
        let tgswFanOutTimer = null;

        function scheduleTcpReconnect() {
            if (tcpReconnectTimer) {
                return;
            }
            const delay = tcpReconnectDelayMs;
            tcpReconnectTimer = setTimeout(() => {
                tcpReconnectTimer = null;
                connectTcp();
            }, delay);
            tcpReconnectDelayMs = Math.min(15000, Math.floor(tcpReconnectDelayMs * 1.5));
        }

        function connectTcp() {
            if (tcpConnecting || tcpConnected) {
                return;
            }
            tcpConnecting = true;
            const socket = net.createConnection(
                { host: node.host, port: node.tcpPort },
                () => {
                    tcpSocket = socket;
                    tcpConnected = true;
                    tcpConnecting = false;
                    tcpReconnectDelayMs = 1000;
                    socket.setKeepAlive(true, 10000);
                }
            );
            socket.on("error", (err) => {
                tcpConnecting = false;
                tcpConnected = false;
                if (tcpSocket === socket) {
                    tcpSocket = null;
                }
                node.warn(`${tag} TCP error: ${err.message}`);
                scheduleTcpReconnect();
            });
            socket.on("close", () => {
                tcpConnecting = false;
                tcpConnected = false;
                if (tcpSocket === socket) {
                    tcpSocket = null;
                }
                scheduleTcpReconnect();
            });
        }

        function sendSetupBatch(postData) {
            return new Promise((resolve) => {
                const body = JSON.stringify(postData) + "\n";
                if (tcpConnected && tcpSocket) {
                    try {
                        tcpSocket.write(body, () => resolve(true));
                        return;
                    } catch (err) {
                        node.warn(`${tag} TCP write failed: ${err.message}`);
                    }
                }
                connectTcp();
                resolve(false);
            });
        }

        function numClose(a, b) {
            const x = Number(a);
            const y = Number(b);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return false;
            }
            return Math.abs(x - y) < DIFF_EPS;
        }

        async function runFanOut(tgswTopic, targetRaw) {
            const slot = SLOT_BY_TGSW[tgswTopic];
            if (!slot) {
                return;
            }
            const target = Number(targetRaw);
            if (!Number.isFinite(target)) {
                return;
            }
            fanOutRunning = true;
            node.status({ fill: "blue", shape: "dot", text: `fan-out ${slot}` });

            const postData = { localhost: {}, forced: true };
            let writes = 0;
            let cached = 0;
            let unknown = 0;

            for (let i = 0; i < TARGETS.length; i++) {
                const t = TARGETS[i];
                const topic = t[slot];
                const cur = readCache[topic];
                if (cur === undefined) {
                    unknown += 1;
                } else {
                    cached += 1;
                }
                // Always write on global save: S read cache can show the target
                // while Modbus still holds the old value (stale SQL from prior ai setup).
                postData.localhost[topic] = { v: Math.round(target * 10), type: "ao" };
                writes += 1;
            }

            if (writes === 0) {
                node.status({ fill: "grey", shape: "ring", text: "no targets" });
                fanOutRunning = false;
                drainPendingFanOut();
                return;
            }

            const ok = await sendSetupBatch(postData);
            const summary = `${tgswTopic}=${target} w=${writes} cache=${cached} unk=${unknown}`;
            if (ok) {
                node.status({ fill: "green", shape: "dot", text: summary });
                node.log(`${tag} fan-out ${summary}`);
            } else {
                node.status({ fill: "red", shape: "ring", text: "TCP down" });
                node.warn(`${tag} fan-out failed (TCP): ${summary}`);
            }
            fanOutRunning = false;
            drainPendingFanOut();
        }

        function drainPendingFanOut() {
            if (pendingFanOut.length === 0) {
                return;
            }
            const p = pendingFanOut.shift();
            runFanOut(p.topic, p.value);
        }

        function queueFanOut(topic, value) {
            if (fanOutRunning) {
                pendingFanOut.push({ topic: topic, value: value });
                return;
            }
            runFanOut(topic, value);
        }

        function scheduleFanOutAll() {
            if (tgswFanOutTimer) {
                clearTimeout(tgswFanOutTimer);
            }
            tgswFanOutTimer = setTimeout(() => {
                tgswFanOutTimer = null;
                for (let i = 0; i < TGSW_TOPICS.length; i++) {
                    const topic = TGSW_TOPICS[i];
                    const val = tgswCache[topic];
                    if (!Number.isFinite(val)) {
                        continue;
                    }
                    queueFanOut(topic, val);
                }
            }, TGSW_FANOUT_DEBOUNCE_MS);
        }

        function onTgswChange(topic, payload) {
            const n = (payload == null ? null : (Number.isFinite(Number(payload)) ? Number(payload) : null));
            if (n === null) {
                return;
            }
            const prev = tgswCache[topic];
            tgswCache[topic] = n;
            if (prev !== undefined && numClose(prev, n)) {
                return;
            }
            scheduleFanOutAll();
        }

        function cacheRead(topic, payload) {
            const n = (payload == null ? null : (Number.isFinite(Number(payload)) ? Number(payload) : null));
            if (n === null) {
                return;
            }
            readCache[topic] = n;
        }

        node.on("input", (msg, send, done) => {
            const t = String(msg.topic || "").trim();
            if (!t) {
                done();
                return;
            }
            if (TGSW_TOPICS.indexOf(t) >= 0) {
                onTgswChange(t, msg.payload);
                done();
                return;
            }
            if (readCache[t] !== undefined || t.indexOf("SAC") === 0 || t.indexOf("SAN") === 0 ||
                t.indexOf("SBC") === 0 || t.indexOf("SBN") === 0) {
                cacheRead(t, msg.payload);
            }
            done();
        });

        connectTcp();
        node.log(
            `${tag} started v${THERMOKON_GLOBAL_SP_VERSION} targets=${TARGETS.length}` +
            ` flats=${MANIFEST.length} tcp=${node.host}:${node.tcpPort}`
        );
    }

    RED.nodes.registerType("uniflex-thermokon-global-sp", ThermokonGlobalSpNode);
};
