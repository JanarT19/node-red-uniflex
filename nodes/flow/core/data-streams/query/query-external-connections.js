const http = require("http");
const ts = require("../../lib/timestamp.js");

// Custom node to query the external connections of a controller: SDP, MQTT, VPN
module.exports = function (RED) {
    function QueryExternalConnectionsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Retrieve configuration settings
        node.name = config.name;
        node.interval = config.interval;

        var previousValues = {};
        var requestInProgress = false;

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Validation constants
        const invalidValues = ["", null, undefined];

        const interval = node.interval;

        // Basic validation
        if (invalidValues.includes(interval) || isNaN(interval) || interval < 5 || interval > 7200) {
            node.error(`Interval must be between 5 - 7200`);
            node.status({ fill: "red", shape: "dot", text: `Invalid interval: ${interval}` });
            return;
        }

        // Due to Promises, set default status before processing the data
        node.status({
            fill: "grey",
            shape: "dot",
            text: `Querying status every ${interval} seconds`
        });

        // Query immediately and then periodically
        setTimeout(queryHTTP, 1000);
        const query = setInterval(queryHTTP, interval * 1000);

        node.on("close", function (done) {
            clearInterval(query);
            node.status({});
            done();
        });

        // Send the POST request to the controller
        function queryHTTP() {
            // Skip if a request is already in progress for this row
            if (requestInProgress) {
                node.status({ fill: "yellow", shape: "dot", text: `Request in progress (${ts.formatStatus()})` });
                return;
            }

            requestInProgress = true;

            queryStatus(node)
                .then((obj) => {
                    let links = {};

                    if (obj.success) {
                        links = obj.links;
                        previousValues = { links, timestamp: Date.now() };

                        const connected = Object.values(links).filter((v) => v === true).length;
                        const total = Object.values(links).length;

                        node.status({
                            fill: "green",
                            shape: "dot",
                            text: `Connected ${connected} of ${total} (${ts.formatStatus()})`
                        });
                    }

                    requestInProgress = false;
                    const controller = { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host };

                    // 1. SDP, 2. MQTT, 3. VPN
                    const sdpMsg = { topic: "sdp", payload: links?.sdp, controller };
                    const mqttMsg = { topic: "mqtt", payload: links?.mqtt, controller };
                    const vpnMsg = { topic: "vpn", payload: links?.vpn, controller };

                    node.send([sdpMsg, mqttMsg, vpnMsg]);
                })
                .catch((error) => {
                    node.error(`Error querying connection status: ${error}`, { error });

                    requestInProgress = false;
                    node.send({ payload: false, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                });
        }

        // Method to query additional data via HTTP with retry mechanism
        function queryStatus(node, retries = 3) {
            const options = {
                hostname: node.controller.host,
                port: node.controller.httpPort,
                path: "/links",
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            };

            node.debug(`Querying HTTP: ${JSON.stringify(options)}`);

            return new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    let data = "";

                    res.on("data", (chunk) => {
                        data += chunk;
                    });

                    res.on("end", () => {
                        try {
                            node.debug(`Received HTTP message: ${data}`);
                            const parsedData = JSON.parse(data);
                            const links = parsedData?.links;

                            if (links && Object.keys(links).length > 0) {
                                resolve({ success: true, links });
                            } else {
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);
                                    node.status({ fill: "yellow", shape: "dot", text: `Retrying connectivity query (${ts.formatStatus()})` });

                                    setTimeout(() => {
                                        resolve(queryStatus(node, retries - 1));
                                    }, 500);
                                } else {
                                    node.error(`Failed to query data`, { parsedData });
                                    node.status({ fill: "red", shape: "dot", text: `Failed to query connection status (${ts.formatStatus()})` });

                                    resolve({ success: false });
                                }
                            }
                        } catch (error) {
                            node.status({ fill: "red", shape: "dot", text: `Failed to parse HTTP response (${ts.formatStatus()})` });

                            // Retry if necessary
                            if (retries > 0) {
                                node.warn(`Retrying... (${retries} attempts left)`);

                                setTimeout(() => {
                                    resolve(queryStatus(node, retries - 1));
                                }, 500);
                            } else {
                                node.error(`Failed to parse HTTP response: ${error}`, { error });
                                reject(error);
                            }
                        }
                    });
                });

                req.on("error", (error) => {
                    node.status({ fill: "red", shape: "dot", text: `HTTP request error (${ts.formatStatus()})` });

                    // Retry if necessary
                    if (retries > 0) {
                        node.warn(`Retrying... (${retries} attempts left)`);

                        setTimeout(() => {
                            resolve(queryStatus(node, retries - 1));
                        }, 500);
                    } else {
                        node.error(`HTTP request error: ${error}`, { error });
                        reject(error);
                    }
                });

                req.end();
            });
        }
    }

    RED.nodes.registerType("uniflex-query-external-connections", QueryExternalConnectionsNode);
};
