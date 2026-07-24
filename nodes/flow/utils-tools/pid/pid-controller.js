const ts = require("../../core/lib/timestamp.js");
// Implementation of a PID Controller Node for Node-RED
// This node processes incoming messages to control a PID loop based on setpoint and actual values.
module.exports = function (RED) {
    function PIDControllerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        const outputTopic = config.outputTopic;

        // Individual topic configuration
        const actualTopic = config.actualTopic;
        const setpointTopic = config.setpointTopic;

        const pTopic = config.pTopic;
        const iTopic = config.iTopic;
        const dTopic = config.dTopic;

        const upperLimitTopic = config.upperLimitTopic;
        const lowerLimitTopic = config.lowerLimitTopic;
        const invertTopic = config.invertTopic;

        // Iteration control
        const iterateOnTrigger = config.iterateOnTrigger || false;
        const iterateTopic = config.iterateTopic;

        // Create topics array for processing
        const pidTopics = [actualTopic, setpointTopic, pTopic, iTopic, dTopic, upperLimitTopic, lowerLimitTopic, invertTopic, iterateTopic];

        const INVALID_VALUES = ["", null, undefined];

        // Initialize node state variables
        node.actual_value = null;
        node.setpoint = null;

        node.Kp = null;
        node.Ki = null;
        node.Kd = null;

        node.upper_limit = null;
        node.lower_limit = null;
        node.invert = false; // Default to false (heating mode)

        // Miscellaneous state variables
        node.prevError = 0;
        node.prevProcessVariable = null;
        node.integral = 0;
        node.prevTime = Date.now() - 100; // Subtract 100ms to avoid division by zero

        node.on("input", function (msg) {
            try {
                // If iteration is triggered by specific topic, check if this is the trigger
                if (iterateOnTrigger && msg.topic === iterateTopic) {
                    // This is the trigger message - run PID calculation
                    runPIDCalculation(msg);
                } else if (iterateOnTrigger) {
                    // Store the incoming message values but don't calculate yet
                    const processed = processMessage(msg);
                    if (processed === null) return; // Do not proceed

                    // Update status to show we're waiting for trigger
                    const validated = validateRequiredValues();
                    if (validated) {
                        node.status({ fill: "blue", shape: "dot", text: `Ready, waiting for trigger (${ts.formatStatus()})` });
                    }
                } else {
                    // Normal mode - calculate on every input
                    runPIDCalculation(msg);
                }
            } catch (error) {
                node.error(`PID Controller error: ${error.message}`, msg);
                node.status({ fill: "red", shape: "dot", text: `Error: ${error.message}` });
            }
        });

        // Run the PID calculation
        function runPIDCalculation(msg) {
            // Store the incoming message values
            const processed = processMessage(msg);
            if (processed === null) return; // Do not proceed

            // Initialize prevProcessVariable if not set
            if (node.prevProcessVariable === null) {
                node.prevProcessVariable = node.actual_value;
            }

            node.currentTime = Date.now();

            // Check if all required values are available
            const validated = validateRequiredValues();
            if (!validated) return; // Do not proceed

            const output = calculate();

            // Store the values updated during function execution
            const error = node.invert ? node.actual_value - node.setpoint : node.setpoint - node.actual_value;
            node.prevError = error;
            node.prevProcessVariable = node.actual_value;
            node.prevTime = node.currentTime;

            // Return the message with the output and metadata
            const metadata = {
                actual_value: node.actual_value,
                setpoint: node.setpoint,

                Kp: node.Kp,
                Ki: node.Ki,
                Kd: node.Kd,

                upper_limit: node.upper_limit,
                lower_limit: node.lower_limit,
                invert: node.invert,

                integral: node.integral,
                prevError: node.prevError,
                prevProcessVariable: node.prevProcessVariable
            };

            const outputMsg = createMsg(output, outputTopic, metadata, msg);
            node.send(outputMsg);
        }

        // Calculate the PID output
        function calculate() {
            // Time difference in seconds
            let dt = (node.currentTime - node.prevTime) / 1000; // Convert ms to seconds

            // Calculate error with optional inversion for cooling mode
            const error = node.invert ? node.actual_value - node.setpoint : node.setpoint - node.actual_value;

            // Proportional term
            let P = node.Kp * error;

            // Integral term
            node.integral += error * dt; // Accumulate the integral

            // Derivative term based on process variable, not error
            let D = (node.Kd * (node.actual_value - node.prevProcessVariable)) / dt;

            // Compute the PID output
            let output = P + node.Ki * node.integral + D;

            // Apply output limits and handle windup prevention
            if (output > node.upper_limit) {
                output = node.upper_limit;
                node.integral -= error * dt; // Prevent integral windup in the upward direction
            } else if (output < node.lower_limit) {
                output = node.lower_limit;
                node.integral -= error * dt; // Prevent integral windup in the downward direction
            }

            output = parseFloat(output.toFixed(2)); // Round to 2 decimal places

            node.status({ fill: "green", shape: "dot", text: `Output: ${output} (${ts.formatStatus()})` });

            return output;
        }

        // ===============
        // Helper functions
        // ===============

        /**
         * Check if the specified object is an object (not an array or null)
         */
        function isObject(obj) {
            return obj !== null && typeof obj === "object" && !Array.isArray(obj);
        }

        /**
         * Create a message with the specified payload, topic, and metadata
         */
        function createMsg(payload, topic = null, metadata = null, originalMsg = {}) {
            const msg = { ...originalMsg };
            msg.payload = payload;

            delete msg.topic;
            if (topic) msg.topic = topic;
            if (metadata) msg.metadata = metadata;

            return msg;
        }

        /**
         * Process the incoming message and store the value(s) in context
         * This node can parse messages in 3 different formats.
         * Return null if the message is unknown
         */
        function processMessage(msg) {
            // Find the topic in the incoming message
            const msgTopic = msg.topic;
            const topicIndex = pidTopics.indexOf(msgTopic);

            if (topicIndex !== -1) {
                // Single topic format: msg = { topic: "topic-1", payload: 0.1 }
                if (!isInvalidValue(msgTopic, msg.payload)) {
                    setNodePropertyByIndex(topicIndex, msg.payload);
                }
            } else {
                // Check for object format: msg = { "topic-1": 0.1, "topic-2": 0.2, ...}
                const matchingTopics = Object.keys(msg).filter((key) => pidTopics.includes(key));

                if (matchingTopics.length > 0) {
                    setVariables(matchingTopics, msg);
                } else if (isObject(msg.payload)) {
                    // Check for nested payload format: msg = { payload: { "topic-1": 0.1, "topic-2": 0.2, ...} }
                    const nestedMatchingTopics = Object.keys(msg.payload).filter((key) => pidTopics.includes(key));

                    if (nestedMatchingTopics.length > 0) {
                        setVariables(nestedMatchingTopics, msg.payload);
                    } else {
                        node.status({ fill: "grey", shape: "dot", text: `Unknown topic (${ts.formatStatus()})` });
                        return null;
                    }
                } else {
                    node.status({ fill: "grey", shape: "dot", text: `Unknown topic (${ts.formatStatus()})` });
                    return null;
                }
            }

            // Helper function to set node property by topic index
            function setNodePropertyByIndex(index, value) {
                switch (index) {
                    case 0:
                        node.actual_value = value;
                        break;
                    case 1:
                        node.setpoint = value;
                        break;
                    case 2:
                        node.Kp = value;
                        break;
                    case 3:
                        node.Ki = value;
                        break;
                    case 4:
                        node.Kd = value;
                        break;
                    case 5:
                        node.upper_limit = value;
                        break;
                    case 6:
                        node.lower_limit = value;
                        break;
                    case 7:
                        node.invert = Boolean(value);
                        break;
                }
            }

            // Check if a value is missing or invalid
            function isInvalidValue(topic, value) {
                if (INVALID_VALUES.includes(value)) {
                    node.status({ fill: "red", shape: "dot", text: `Invalid value for ${topic} (${ts.formatStatus()})` });
                    return true; // Do not proceed if the value is missing
                }

                return false;
            }

            // Loop through the topics and store the values in node properties
            function setVariables(topics = [], obj = {}) {
                for (const t of topics) {
                    if (isInvalidValue(t, obj[t])) break;

                    const topicIndex = pidTopics.indexOf(t);

                    if (topicIndex !== -1) {
                        setNodePropertyByIndex(topicIndex, obj[t]);
                    }
                }
            }
        }

        /**
         * In case of missing or invalid values, the function returns either true or false
         */
        function validateRequiredValues() {
            const requiredValues = [node.actual_value, node.setpoint, node.Kp, node.Ki, node.Kd, node.upper_limit, node.lower_limit];

            // Check if all required values are available
            if (requiredValues.some((value) => INVALID_VALUES.includes(value))) {
                const missingCount = requiredValues.filter((value) => INVALID_VALUES.includes(value)).length;

                node.status({ fill: "yellow", shape: "dot", text: `Waiting for topics: ${missingCount}/7 (${ts.formatStatus()})` });

                return false;
            }

            return true;
        }

        // Clean up on node removal
        node.on("close", function () {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-pid-controller", PIDControllerNode);
};
