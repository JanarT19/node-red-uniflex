// multivibrator.js
// Astable multivibrator: toggles output 0/1 on a fixed period.
// Optional direct iolayer write (TCP 19080 or HTTP /setup) bypasses write-data-streams mapping.

const net = require("net");
const http = require("http");
const ts = require("../../core/lib/timestamp.js");

module.exports = function (RED) {
    function MultivibratorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.outputTopic = config.outputTopic || "";
        let periodSec = Number(config.periodSec ?? 10);
        if (!Number.isFinite(periodSec) || periodSec < 0.1) {
            periodSec = 10;
        }
        node.periodSec = periodSec;
        node.startValue = config.startValue !== undefined ? Number(config.startValue) : 0;
        node.traceLabel = (config.traceLabel || "mv").trim();
        node.directWrite = config.directWrite !== false;
        node.transport = config.transport === "http" ? "http" : "raw_tcp";
        node.host = (config.host || "127.0.0.1").trim();
        node.tcpPort = parseInt(config.tcpPort, 10) || 19080;
        node.httpPort = parseInt(config.httpPort, 10) || 80;
        node.channelType = (config.channelType || "do").trim();

        let state = node.startValue ? 1 : 0;
        let timer = null;
        let tcpSocket = null;
        let tcpConnected = false;
        let tcpConnecting = false;
        let tcpReconnectTimer = null;
        let tcpReconnectDelayMs = 1000;

        function parseTopic(topic) {
            if (!topic || typeof topic !== "string") {
                return null;
            }
            const dot = topic.lastIndexOf(".");
            if (dot <= 0) {
                return null;
            }
            const key = topic.slice(0, dot);
            const member = parseInt(topic.slice(dot + 1), 10);
            if (!key || !Number.isFinite(member) || member < 1) {
                return null;
            }
            return { key, member, km: `${key}.${member}` };
        }

        function buildSetupBody(value) {
            const parsed = parseTopic(node.outputTopic);
            if (!parsed) {
                return null;
            }
            return {
                localhost: {
                    [parsed.km]: {
                        v: value ? 1 : 0,
                        type: node.channelType
                    }
                }
            };
        }

        function buildTcpFrame(postData) {
            return JSON.stringify(postData) + "\n";
        }

        function scheduleTcpReconnect() {
            if (tcpReconnectTimer || node.transport !== "raw_tcp") {
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
            if (node.transport !== "raw_tcp" || tcpConnecting || tcpConnected) {
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
                node.warn(`[multivibrator] TCP error: ${err.message}`);
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

        function sendHttpSetup(postData) {
            return new Promise((resolve) => {
                const body = JSON.stringify(postData);
                const options = {
                    hostname: node.host,
                    port: node.httpPort,
                    path: "/setup",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body)
                    }
                };
                const req = http.request(options, (res) => {
                    let data = "";
                    res.on("data", (chunk) => { data += chunk; });
                    res.on("end", () => {
                        try {
                            const parsed = JSON.parse(data || "{}");
                            resolve(parsed.result === true);
                        } catch (e) {
                            resolve(false);
                        }
                    });
                });
                req.on("error", () => resolve(false));
                req.write(body);
                req.end();
            });
        }

        function writeToIolayer(value, reason) {
            if (!node.directWrite) {
                return;
            }
            const postData = buildSetupBody(value);
            if (!postData) {
                node.error(`[multivibrator] directWrite: invalid topic "${node.outputTopic}" (need KEY.MEMBER, e.g. DO41W.7)`);
                return;
            }

            const parsed = parseTopic(node.outputTopic);
            const via = node.transport === "raw_tcp" ? "tcp" : "http";

            if (node.transport === "raw_tcp") {
                if (!tcpConnected || !tcpSocket) {
                    connectTcp();
                    sendHttpSetup(postData).then((ok) => {
                        if (ok) {
                            node.warn(`[multivibrator] ${parsed.km}=${value ? 1 : 0} via http fallback (${reason})`);
                        } else {
                            node.warn(`[multivibrator] write failed ${parsed.km}=${value ? 1 : 0} tcp down, http fallback failed (${reason})`);
                        }
                    });
                    return;
                }
                try {
                    tcpSocket.write(buildTcpFrame(postData));
                    node.warn(`[multivibrator] ${parsed.km}=${value ? 1 : 0} via tcp (${reason})`);
                } catch (err) {
                    node.warn(`[multivibrator] TCP write failed: ${err.message}`);
                    sendHttpSetup(postData).then((ok) => {
                        if (ok) {
                            node.warn(`[multivibrator] ${parsed.km}=${value ? 1 : 0} via http fallback (${reason})`);
                        }
                    });
                }
                return;
            }

            sendHttpSetup(postData).then((ok) => {
                if (ok) {
                    node.warn(`[multivibrator] ${parsed.km}=${value ? 1 : 0} via http (${reason})`);
                } else {
                    node.warn(`[multivibrator] write failed ${parsed.km}=${value ? 1 : 0} via http (${reason})`);
                }
            });
        }

        function emit(reason) {
            const ts = Date.now();
            const msg = {
                payload: state,
                _traceTs: ts,
                _traceStep: node.traceLabel,
                _traceReason: reason || "toggle"
            };
            if (node.outputTopic) {
                msg.topic = node.outputTopic;
            }
            writeToIolayer(state, reason || "toggle");
            node.send(msg);

            const mode = node.directWrite ? node.transport : "msg only";
            node.status({
                fill: state ? "green" : "grey",
                shape: "dot",
                text: `${state ? "ON" : "OFF"} / ${periodSec}s / ${mode}`
            });
        }

        function toggle(reason) {
            state = state ? 0 : 1;
            emit(reason);
        }

        function scheduleNext() {
            if (timer) {
                clearInterval(timer);
            }
            timer = setInterval(() => toggle("period"), node.periodSec * 1000);
        }

        if (node.directWrite && node.transport === "raw_tcp") {
            connectTcp();
        }

        emit("start");
        scheduleNext();

        node.on("close", (done) => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (tcpReconnectTimer) {
                clearTimeout(tcpReconnectTimer);
                tcpReconnectTimer = null;
            }
            if (tcpSocket) {
                try {
                    tcpSocket.destroy();
                } catch (e) {
                    // ignore
                }
                tcpSocket = null;
            }
            node.status({});
            if (done) {
                done();
            }
        });
    }

    RED.nodes.registerType("uniflex-multivibrator", MultivibratorNode);
};
