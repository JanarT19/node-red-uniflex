const http = require("http");
const ts = require("../lib/timestamp.js");

// Custom node to perform CRUD operations via the /calendar endpoint.
module.exports = function (RED) {
    function SecurityNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        var previousValues = {};

        // Retrieve configuration settings
        node.name = config.name;
        node.topic = config.topic;
        node.operationMode = config.operationMode;
        node.outputMode = config.outputMode;

        node.username = config.username;
        node.usernameType = config.usernameType;

        node.password = config.password;
        node.passwordType = config.passwordType;

        node.authorized = config.authorized;
        node.authorizedType = config.authorizedType;

        node.expiration = config.expiration;
        node.expirationType = config.expirationType;

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Check for unnecessary form values
        const invalidValues = ["", null, undefined];
        const operationModeValid = ["check", "auth"];
        const outputModeValid = ["status", "passThroughAuth", "passThroughNotAuth"];
        const authroziedValid = [true, false];

        // Listen for input messages
        node.on("input", function (msg) {
            const operationMode = node.operationMode;
            const outputMode = node.outputMode;
            const topic = node.topic;

            const username = evaluate(node.username, node.usernameType, node, msg);
            const password = evaluate(node.password, node.passwordType, node, msg);
            const authorized = evaluate(node.authorized, node.authorizedType, node, msg);
            let expiration = evaluate(node.expiration, node.expirationType, node, msg);

            // Convert date objects and ISO strings to timestamps
            if (expiration instanceof Date) expiration = expiration.getTime();
            if (typeof expiration === "string") expiration = new Date(expiration).getTime();

            // Basic validation
            if (!operationModeValid.includes(operationMode)) {
                node.error(`Operation mode must be one of: ${operationModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid operation mode: ${operationMode}` });
                return;
            }

            if (!outputModeValid.includes(outputMode)) {
                node.error(`Operation mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${outputMode}` });
                return;
            }

            // Required: title, timestamp, source
            // Optional: description, value
            if (operationMode === "auth") {
                if (invalidValues.includes(username)) {
                    node.error("Username required");
                    node.status({ fill: "red", shape: "dot", text: "Username required" });
                    return;
                }

                if (invalidValues.includes(password)) {
                    node.error("Password required");
                    node.status({ fill: "red", shape: "dot", text: "Password required" });
                    return;
                }

                if (!authroziedValid.includes(authorized)) {
                    node.error(`Authorized must be one of: ${authroziedValid.join(", ")}`);
                    node.status({ fill: "red", shape: "dot", text: "Invalid authorized variable" });
                    return;
                }
            }

            const parameters = { username, authorized, expiration, operationMode, outputMode };

            // Initialize the previous values object
            const previousRequest = getPreviousValue(parameters, "request");

            // Skip if a request is already in progress for this row
            if (previousRequest) {
                node.status({ fill: "yellow", shape: "dot", text: `Request in progress for ${title || "event"} (${ts.formatStatus()})` });
                return;
            }

            // Build the POST request
            const postData = {
                configuration: { username, password, authorized, expiration }
            };

            setPreviousRequest(parameters, true);

            // Send the POST request to the controller
            sendAuthOperation(node, postData, parameters)
                .then((result) => {
                    setPreviousRequest(parameters, false);

                    const success = result?.success;

                    const outMsg = {
                        ...msg,
                        ...(!invalidValues.includes(topic) && { topic })
                    };

                    if (outputMode === "status") {
                        node.send({
                            ...outMsg,
                            payload: result,
                            parameters,
                            controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host }
                        });
                    } else if (outputMode === "passThroughAuth" && success === true) {
                        node.send(outMsg);
                    } else if (outputMode === "passThroughNotAuth" && success === false) {
                        node.send(outMsg);
                    }
                })
                .catch((error) => {
                    node.error(`Error sending authentication: ${error}`, { error });

                    setPreviousRequest(parameters, false);

                    const outMsg = {
                        ...msg,
                        ...(!invalidValues.includes(topic) && { topic })
                    };

                    node.send({
                        ...outMsg,
                        payload: false,
                        parameters,
                        controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host }
                    });
                });
        });

        // Method to query additional data via HTTP with retry mechanism
        function sendAuthOperation(node, postData = {}, parameters = {}, retries = 0) {
            const { operationMode } = parameters;

            let path = "/program-auth";
            let method = "GET";

            if (operationMode === "auth") method = "POST";

            const options = {
                hostname: node.controller.host,
                port: node.controller.httpPort,
                path: path,
                method: method,
                headers: {
                    "Content-Type": "application/json"
                }
            };

            node.debug(`Querying HTTP: ${JSON.stringify(options)} with body ${JSON.stringify(parameters)}`);

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

                            if (parsedData) {
                                let fill = "";
                                let message = "";

                                if (operationMode === "check") {
                                    message = parsedData.message ?? "Request sent";
                                    fill = parsedData.success ? "green" : "red";
                                }

                                if (operationMode === "auth") {
                                    message = parsedData.message ?? "Request sent";
                                    fill = parsedData.success ? "green" : "red";
                                }

                                node.status({ fill: fill, shape: "dot", text: `${message} (${ts.formatStatus()})` });

                                resolve(parsedData);
                            } else {
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);
                                    node.status({ fill: "yellow", shape: "dot", text: `Retrying sending data (${ts.formatStatus()})` });

                                    setTimeout(() => {
                                        resolve(sendAuthOperation(node, postData, parameters, retries - 1));
                                    }, 500);
                                } else {
                                    node.error(`Failed to send data`, parameters);
                                    node.status({ fill: "red", shape: "dot", text: `Failed to send data (${ts.formatStatus()})` });

                                    resolve(false);
                                }
                            }
                        } catch (error) {
                            node.status({ fill: "red", shape: "dot", text: `Failed to parse HTTP response (${ts.formatStatus()})` });

                            // Retry if necessary
                            if (retries > 0) {
                                node.warn(`Retrying... (${retries} attempts left)`);

                                setTimeout(() => {
                                    resolve(sendAuthOperation(node, postData, parameters, retries - 1));
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
                            resolve(sendAuthOperation(node, postData, parameters, retries - 1));
                        }, 500);
                    } else {
                        node.error(`HTTP request error: ${error}`, { error });
                        reject(error);
                    }
                });

                // Write data to request body
                if (method !== "GET") {
                    req.write(JSON.stringify(postData));
                }

                req.end();
            });
        }

        // Evaluate the value of a property, catching any errors (e.g. read properties of undefined : msg.payload.success)
        function evaluate(value, type, node, msg) {
            try {
                return RED.util.evaluateNodeProperty(value, type, node, msg);
            } catch (err) {
                return undefined;
            }
        }

        function getPreviousValue(parameters = {}, key = "title") {
            const { title = "_default" } = parameters;

            if (!previousValues[title]) previousValues[title] = { title: null, value: null, start: null, request: null };

            return previousValues[title][key] ?? null;
        }

        function setPreviousRequest(parameters = {}, status = null) {
            const { title = "_default" } = parameters;

            previousValues[title].request = status;
        }
    }

    RED.nodes.registerType("uniflex-security", SecurityNode);
};
