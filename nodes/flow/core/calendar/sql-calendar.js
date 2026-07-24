const http = require("http");
const ts = require("../lib/timestamp.js");

// Helper function to identify message sender for debugging
// Can be extracted to a shared utility module for use across all nodes
function getMessageSource(RED, msg) {
    let source = "unknown";

    // Try msg._path (contains node IDs the message passed through)
    if (msg._path) {
        const pathNodes = Array.isArray(msg._path) ? msg._path : [msg._path];
        if (pathNodes.length > 0) {
            const sourceId = pathNodes[pathNodes.length - 1];
            const sourceNode = RED.nodes.getNode(sourceId);
            source = sourceNode ? sourceNode.name || sourceNode.id : sourceId;
        }
    }

    return source;
}

// Custom node to perform CRUD operations via the /calendar endpoint.
module.exports = function (RED) {
    function SqlCalendarNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        var previousValues = {};

        // Retrieve configuration settings
        node.name = config.name;
        node.topic = config.topic;
        node.operationMode = config.operationMode;

        node.eventId = config.eventId;
        node.eventIdType = config.eventIdType;

        node.title = config.title;
        node.titleType = config.titleType;

        node.value = config.value;
        node.valueType = config.valueType;

        node.timestamp = config.timestamp;
        node.timestampType = config.timestampType;

        node.start = config.start;
        node.startType = config.startType;

        node.end = config.end;
        node.endType = config.endType;

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
        const operationModeValid = ["auto", "check", "create", "read", "update", "delete"];

        // Listen for input messages
        node.on("input", function (msg) {
            // Allow incoming message to override operation mode
            const operationMode = msg.mode || msg.operationMode || node.operationMode;

            // If configured as "auto", msg.mode is required
            if (node.operationMode === "auto" && !msg.mode && !msg.operationMode) {
                // Silently skip messages without mode (e.g., monitoring data passing through)
                return;
            }

            // Preserve incoming msg.topic for routing, fall back to configured topic
            const topic = msg.topic || node.topic;

            const id = parseInt(evaluate(node.eventId, node.eventIdType, node, msg));
            const title = evaluate(node.title, node.titleType, node, msg);
            const value = evaluate(node.value, node.valueType, node, msg);
            let timestamp = evaluate(node.timestamp, node.timestampType, node, msg);
            let start = evaluate(node.start, node.startType, node, msg);
            let end = evaluate(node.end, node.endType, node, msg);

            // Convert date objects and ISO strings to unix timestamps in seconds (calendar uses seconds)
            if (timestamp instanceof Date) timestamp = Math.floor(timestamp.getTime() / 1000);
            if (typeof timestamp === "string") timestamp = Math.floor(new Date(timestamp).getTime() / 1000);

            if (start instanceof Date) start = Math.floor(start.getTime() / 1000);
            if (typeof start === "string") start = Math.floor(new Date(start).getTime() / 1000);

            if (end instanceof Date) end = Math.floor(end.getTime() / 1000);
            if (typeof end === "string") end = Math.floor(new Date(end).getTime() / 1000);

            // Basic validation
            if (!operationModeValid.includes(operationMode)) {
                node.error(`Operation mode must be one of: ${operationModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid operation mode: ${operationMode}` });
                return;
            }

            // Required: title, timestamp
            // Optional: value
            if (operationMode === "create") {
                if (invalidValues.includes(title)) {
                    node.error("Event title required");
                    node.status({ fill: "red", shape: "dot", text: "Event title required" });
                    return;
                }

                if (invalidValues.includes(timestamp) && (invalidValues.includes(start) || invalidValues.includes(end))) {
                    node.error("Timestamp required");
                    node.status({ fill: "red", shape: "dot", text: "Event timestamp(s) required" });
                    return;
                }
            }

            // Required: eventId, title, timestamp
            // Optional: value
            if (operationMode === "update") {
                if (invalidValues.includes(id) || isNaN(id)) {
                    node.error("Valid eventId required");
                    node.status({ fill: "red", shape: "dot", text: "Valid eventId required" });
                    return;
                }

                if (invalidValues.includes(title)) {
                    node.error("Event title required");
                    node.status({ fill: "red", shape: "dot", text: "Event title required" });
                    return;
                }

                if (invalidValues.includes(timestamp)) {
                    node.error("Timestamp required");
                    node.status({ fill: "red", shape: "dot", text: "Event timestamp required" });
                    return;
                }
            }

            // Required: eventId OR mix of title, value, start, end
            if (operationMode === "delete") {
                if (
                    (invalidValues.includes(id) || isNaN(id)) &&
                    invalidValues.includes(title) &&
                    invalidValues.includes(value) &&
                    invalidValues.includes(start) &&
                    invalidValues.includes(end)
                ) {
                    node.error("At least one parameter required");
                    node.status({ fill: "red", shape: "dot", text: "At least one parameter required" });
                    return;
                }
            }

            const parameters = { id, title, value, timestamp, start, end, operationMode };

            // Initialize the previous values object
            const requestKey = getRequestKey(parameters);
            const previousRequest = getPreviousValue(parameters, "request");

            // Skip if a request is already in progress for this row
            if (previousRequest) {
                if (node.enableLogging) {
                    node.log(`Skipping duplicate request for key: ${requestKey}`);
                }
                node.status({ fill: "yellow", shape: "dot", text: `Request in progress for ${title || "event"} (${ts.formatStatus()})` });
                return;
            }

            if (node.enableLogging && operationMode === "create") {
                node.log(`Processing create request with key: ${requestKey}`);
            }

            // Build the POST request
            const postData = {
                configuration: { id, title, value, timestamp, start, end, check: operationMode === "check" }
            };

            // Remove empty values
            for (const key in postData.configuration) {
                const val = postData.configuration[key];

                if (invalidValues.includes(val) || (["id", "timestamp", "start", "end"].includes(key) && isNaN(val))) {
                    delete postData.configuration[key];
                }
            }

            // Remove 'check' parameter from POST/PUT requests (only used in GET queries)
            if (operationMode !== "check" && operationMode !== "read") {
                delete postData.configuration.check;
            }

            setPreviousRequest(parameters, true);

            // Send the POST request to the controller
            sendCalendarOperation(node, postData, parameters)
                .then((result) => {
                    setPreviousRequest(parameters, false);

                    const outMsg = {
                        ...msg,
                        ...(!invalidValues.includes(topic) && { topic })
                    };

                    node.send({ ...outMsg, payload: result, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                })
                .catch((error) => {
                    node.error(`Error sending calendar value: ${error}`, { error });

                    setPreviousRequest(parameters, false);

                    const outMsg = {
                        ...msg,
                        ...(!invalidValues.includes(topic) && { topic })
                    };

                    node.send({ ...outMsg, payload: false, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                });
        });

        // Method to query additional data via HTTP with retry mechanism
        function sendCalendarOperation(node, postData = {}, parameters = {}, retries = 3) {
            const { operationMode } = parameters;

            let path = "/calendar";
            let method = "GET";

            if (operationMode === "create") method = "POST";
            if (operationMode === "update") method = "PUT";
            if (operationMode === "delete") method = "DELETE";

            // Build query parameters for GET requests
            if (method === "GET" || method === "DELETE") {
                let parameters = "";

                for (const key in postData.configuration) {
                    parameters += `&${key}=${encodeURIComponent(postData.configuration[key])}`;
                }

                parameters = parameters.slice(1);
                if (parameters) path = `/calendar?${parameters}`;
            }

            const options = {
                hostname: node.controller.host,
                port: node.controller.httpPort,
                path: path,
                method: method,
                timeout: 10000,
                headers: {
                    "Content-Type": "application/json"
                }
            };

            node.log(`Querying HTTP: ${JSON.stringify(options)} with body ${JSON.stringify(postData)}`);

            return new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    let data = "";

                    res.on("data", (chunk) => {
                        data += chunk;
                    });

                    res.on("end", () => {
                        try {
                            node.log(`Received HTTP message: ${data}`);
                            const parsedData = JSON.parse(data);

                            if (parsedData?.success === true || parsedData) {
                                node.status({
                                    fill: "green",
                                    shape: "dot",
                                    text: `Calendar entry ${operationMode}${["read", "check"].includes(operationMode) ? "" : "d"} (${ts.formatStatus()})`
                                });

                                resolve(parsedData);
                            } else {
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);
                                    node.status({ fill: "yellow", shape: "dot", text: `Retrying sending data (${ts.formatStatus()})` });

                                    setTimeout(() => {
                                        resolve(sendCalendarOperation(node, postData, parameters, retries - 1));
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
                                    resolve(sendCalendarOperation(node, postData, parameters, retries - 1));
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
                            resolve(sendCalendarOperation(node, postData, parameters, retries - 1));
                        }, 500);
                    } else {
                        node.error(`HTTP request error: ${error}`, { error });
                        reject(error);
                    }
                });

                req.on("timeout", () => {
                    node.error(`HTTP request timed out (10s) for ${method} ${path} -- request will be destroyed. This can cause the enable signal to get stuck!`);
                    node.status({ fill: "red", shape: "dot", text: `HTTP timeout (${ts.formatStatus()})` });
                    req.destroy();
                });

                // Write data to request body
                if (method !== "GET" && method !== "DELETE") {
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

        /**
         * Generate a unique key for duplicate detection
         * Uses title + time parameters to distinguish different events with same title
         */
        function getRequestKey(parameters) {
            const { title = "_default", start, end, timestamp, id } = parameters;

            // For events with start/end (range events), use title + start + end
            if (start !== undefined && start !== null && end !== undefined && end !== null) {
                return `${title}:${start}:${end}`;
            }

            // For events with timestamp, use title + timestamp
            if (timestamp !== undefined && timestamp !== null) {
                return `${title}:${timestamp}`;
            }

            // For updates/deletes with eventId, use title + id
            if (id !== undefined && id !== null && !isNaN(id)) {
                return `${title}:${id}`;
            }

            // Fallback to title only (for check/read operations)
            return title;
        }

        function getPreviousValue(parameters = {}, key = "title") {
            const requestKey = getRequestKey(parameters);

            if (!previousValues[requestKey]) previousValues[requestKey] = { title: null, value: null, start: null, request: null };

            return previousValues[requestKey][key] ?? null;
        }

        function setPreviousRequest(parameters = {}, status = null) {
            const requestKey = getRequestKey(parameters);

            if (!previousValues[requestKey]) previousValues[requestKey] = { title: null, value: null, start: null, request: null };

            previousValues[requestKey].request = status;
        }
    }

    RED.nodes.registerType("uniflex-sql-calendar", SqlCalendarNode);
};
