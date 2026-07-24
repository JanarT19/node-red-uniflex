const ts = require("../../core/lib/timestamp.js");
// Implementation of a Dual Limit Inverter Control Node for Node-RED
// This node processes incoming messages to control inverter setpoints with dual grid limits.
module.exports = function (RED) {
    function InverterControlDualLimitsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        const outputTopic = config.outputTopic;

        // Individual topic configuration
        const topicCurrentGrid1Power = config.topicCurrentGrid1Power;
        const topicCurrentGrid2Power = config.topicCurrentGrid2Power;
        const topicExternalSetpoint = config.topicExternalSetpoint;

        const topicMaxGrid1Import = config.topicMaxGrid1Import;
        const topicMaxGrid1Export = config.topicMaxGrid1Export;
        const topicMaxGrid2Import = config.topicMaxGrid2Import;
        const topicMaxGrid2Export = config.topicMaxGrid2Export;

        const topicMaxInverterImport = config.topicMaxInverterImport;
        const topicMaxInverterExport = config.topicMaxInverterExport;

        const topicDebug = config.topicDebug;

        // Create topics array for processing
        const inverterTopics = [
            topicCurrentGrid1Power,
            topicCurrentGrid2Power,
            topicExternalSetpoint,
            topicMaxGrid1Import,
            topicMaxGrid1Export,
            topicMaxGrid2Import,
            topicMaxGrid2Export,
            topicMaxInverterImport,
            topicMaxInverterExport,
            topicDebug
        ];

        const INVALID_VALUES = ["", null, undefined];

        // Initialize node state variables
        node.current_grid_1_power = null;
        node.current_grid_2_power = null;
        node.external_setpoint = null;

        node.max_grid_1_import = 1200;
        node.max_grid_1_export = -1200;
        node.max_grid_2_import = 1500;
        node.max_grid_2_export = -1500;
        node.max_inverter_import = 1000;
        node.max_inverter_export = -1000;

        node.print_debug = false;

        // State variables for dual limit control
        node.external_setpoint_prev = 0;
        node.setpoint_1 = 0;
        node.setpoint_2 = 0;
        node.on_inverter_limit_1 = 0;
        node.on_inverter_limit_2 = 0;

        node.on("input", function (msg) {
            try {
                // Store the incoming message values
                const processed = processMessage(msg);
                if (processed === null) return; // Do not proceed

                // Check if all required values are available
                const validated = validateRequiredValues();
                if (!validated) return; // Do not proceed

                // Create self objects for dual limit calculation
                const self1 = createSelfObject(1);
                const self2 = createSelfObject(2);

                // Calculate setpoints for both grids
                const new_setpoint_1 = adjustSetpoint(self1);
                const new_setpoint_2 = adjustSetpoint(self2);

                // Determine final setpoint based on priority logic
                const new_setpoint = determineSetpoint(new_setpoint_1, new_setpoint_2, node.external_setpoint);

                // Update stored values
                node.setpoint_1 = self1.setpoint;
                node.setpoint_2 = self2.setpoint;
                node.on_inverter_limit_1 = self1.on_inverter_limit;
                node.on_inverter_limit_2 = self2.on_inverter_limit;
                node.external_setpoint_prev = node.external_setpoint;

                // Create metadata for output
                const metadata = {
                    1: { ...self1 },
                    2: { ...self2 }
                };

                const outputMsg = createMsg(new_setpoint, outputTopic, metadata, msg);
                node.send(outputMsg);

                // Update node status
                const limitStatus = node.on_inverter_limit_1 !== 0 || node.on_inverter_limit_2 !== 0;
                node.status({
                    fill: limitStatus ? "yellow" : "green",
                    shape: "dot",
                    text: `Output${limitStatus ? " limited" : ""}: ${new_setpoint.toFixed(2)} (${ts.formatStatus()})`
                });
            } catch (error) {
                node.error(`Inverter Control Dual Limits error: ${error.message}`, msg);
                node.status({ fill: "red", shape: "dot", text: `Error: ${error.message}` });
            }
        });

        // Create self object for grid calculation
        function createSelfObject(gridNumber) {
            const self = {};

            if (gridNumber === 1) {
                self.current_grid_power = node.current_grid_1_power;
                self.max_grid_import = node.max_grid_1_import;
                self.max_grid_export = node.max_grid_1_export;
                self.setpoint = node.setpoint_1;
                self.on_inverter_limit = node.on_inverter_limit_1;
            } else {
                self.current_grid_power = node.current_grid_2_power;
                self.max_grid_import = node.max_grid_2_import;
                self.max_grid_export = node.max_grid_2_export;
                self.setpoint = node.setpoint_2;
                self.on_inverter_limit = node.on_inverter_limit_2;
            }

            self.external_setpoint = node.external_setpoint;
            self.external_setpoint_prev = node.external_setpoint_prev;
            self.max_inverter_import = node.max_inverter_import;
            self.max_inverter_export = node.max_inverter_export;

            return self;
        }

        // Compare setpoints and choose the best one (Grid 1 has priority)
        function determineSetpoint(setpoint1, setpoint2, external_setpoint) {
            if (setpoint1 === setpoint2 && setpoint1 === external_setpoint) {
                debug(`both grids agree: ${setpoint1}`);
                return setpoint1;
            } else if (setpoint1 !== external_setpoint) {
                debug(`grid 1 limiting: ${setpoint1} (grid 2: ${setpoint2}, external: ${external_setpoint})`);
                return setpoint1;
            } else {
                debug(`grid 2 limiting: ${setpoint2} (grid 1: ${setpoint1}, external: ${external_setpoint})`);
                return setpoint2;
            }
        }

        // Calculate new setpoint based on external setpoint, limited by grid and inverter capabilities
        function adjustSetpoint(self) {
            let ext_set_change, add_adjustment, new_setpoint;
            let headroom, headroom_import, headroom_export;

            if (self.external_setpoint !== self.external_setpoint_prev) {
                ext_set_change = self.external_setpoint - self.external_setpoint_prev;
                debug(`external_setpoint change ${ext_set_change} from ${self.external_setpoint_prev} to ${self.external_setpoint}`);
            } else {
                ext_set_change = 0;
            }

            if (self.current_grid_power > self.max_grid_import) {
                // above import limit
                add_adjustment = self.max_grid_import - self.current_grid_power;
                debug(`import power overshoot by ${-add_adjustment}`);
            } else if (self.current_grid_power < self.max_grid_export) {
                // above export limit
                add_adjustment = self.max_grid_export - self.current_grid_power;
                debug(`export power overshoot by ${add_adjustment}`);
            } else if (self.current_grid_power > 0 && self.current_grid_power < self.max_grid_import && self.setpoint < self.external_setpoint) {
                // above import limit but setpoint adjusted
                headroom = self.max_grid_import - self.current_grid_power;
                add_adjustment = Math.min(headroom, ext_set_change); // limit to the value of setpoint < external_setpoint
                debug(`add_adjustment ${add_adjustment} W, max of (headroom ${headroom}, ext_set_change ${ext_set_change})`);
            } else if (self.current_grid_power < 0 && self.current_grid_power > self.max_grid_export && self.setpoint > self.external_setpoint) {
                // below export limit but setpoint adjusted
                headroom = self.max_grid_export - self.current_grid_power;
                add_adjustment = Math.max(headroom, ext_set_change);
                debug(`add_adjustment ${add_adjustment} W, min of (headroom ${headroom}, ext_set_change ${ext_set_change})`);
            } else {
                // no adjustments based on current power vs limits needed
                add_adjustment = 0;
                new_setpoint = self.external_setpoint;
            }

            if (add_adjustment !== 0) {
                new_setpoint = self.setpoint + add_adjustment;
                debug(`new_setpoint ${new_setpoint} = setpoint ${self.setpoint} + add_adjustment ${add_adjustment}`);
            } else {
                new_setpoint = self.external_setpoint;
                debug(`no adjustment needed, new_setpoint ${new_setpoint} is the same as externally given`);
            }
            // Setpoint jump from limited state to unlimited must never exceed the headroom!
            headroom_import = self.max_grid_import - self.current_grid_power;
            headroom_export = self.max_grid_export - self.current_grid_power;

            if (new_setpoint - self.setpoint > headroom_import) {
                new_setpoint = self.setpoint + headroom_import; // assume setpoint is negative
                debug(`new_setpoint ${new_setpoint}, change limited by grid import headroom ${headroom_import}!`);

                if (new_setpoint > self.external_setpoint) {
                    new_setpoint = self.external_setpoint;
                    debug(`FIX: new_setpoint ${new_setpoint} limited to external_setpoint ${self.external_setpoint} instead of ${self.setpoint + headroom_import}!`);
                }
            } else if (new_setpoint - self.setpoint < headroom_export) {
                new_setpoint = self.setpoint + headroom_export;
                debug(`new_setpoint ${new_setpoint}, change limited by grid export headroom ${headroom_export}!`);

                if (new_setpoint < self.external_setpoint) {
                    new_setpoint = self.external_setpoint;
                    debug(`FIX: new_setpoint ${new_setpoint} limited to external_setpoint ${self.external_setpoint} instead of ${self.setpoint + headroom_export}!`);
                }
            }

            // Ensure the new setpoint does not exceed the inverter's capabilities
            if (new_setpoint > self.max_inverter_import) {
                new_setpoint = self.max_inverter_import;
                self.on_inverter_limit = 1;
                debug(`new_setpoint ${new_setpoint} limited by inverter import limit!`);
            } else if (new_setpoint < self.max_inverter_export) {
                new_setpoint = self.max_inverter_export;
                self.on_inverter_limit = -1;
                debug(`new_setpoint ${new_setpoint} limited by inverter export limit!`);
            } else {
                self.on_inverter_limit = 0;
            }

            if (self.setpoint !== new_setpoint) {
                self.setpoint = new_setpoint; // may include cumulative adjustments
                debug(`new setpoint ${self.setpoint} is set, on_inverter_limit ${self.on_inverter_limit}`);
            }

            new_setpoint = parseFloat(new_setpoint.toFixed(2)); // Round to 2 decimal places

            return new_setpoint;
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
         * Log a debug message if the flag is enabled
         */
        function debug(str) {
            if (node.print_debug) {
                node.debug(str);
            }
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
         * Process the incoming message and store the value(s) in node properties
         * This node can parse messages in 3 different formats.
         * Return null if the message is unknown
         */
        function processMessage(msg) {
            // Find the topic in the incoming message
            const msgTopic = msg.topic;
            const topicIndex = inverterTopics.indexOf(msgTopic);

            if (topicIndex !== -1) {
                // Single topic format: msg = { topic: "topic-1", payload: 0.1 }
                if (!isInvalidValue(msgTopic, msg.payload)) {
                    setNodePropertyByIndex(topicIndex, msg.payload);
                }
            } else {
                // Check for object format: msg = { "topic-1": 0.1, "topic-2": 0.2, ...}
                const matchingTopics = Object.keys(msg).filter((key) => inverterTopics.includes(key));

                if (matchingTopics.length > 0) {
                    setVariables(matchingTopics, msg);
                } else if (isObject(msg.payload)) {
                    // Check for nested payload format: msg = { payload: { "topic-1": 0.1, "topic-2": 0.2, ...} }
                    const nestedMatchingTopics = Object.keys(msg.payload).filter((key) => inverterTopics.includes(key));

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
                        node.current_grid_1_power = value;
                        break;
                    case 1:
                        node.current_grid_2_power = value;
                        break;
                    case 2:
                        node.external_setpoint = value;
                        break;
                    case 3:
                        node.max_grid_1_import = value;
                        break;
                    case 4:
                        node.max_grid_1_export = value;
                        break;
                    case 5:
                        node.max_grid_2_import = value;
                        break;
                    case 6:
                        node.max_grid_2_export = value;
                        break;
                    case 7:
                        node.max_inverter_import = value;
                        break;
                    case 8:
                        node.max_inverter_export = value;
                        break;
                    case 9:
                        node.print_debug = value;
                        break;
                }
            }

            // Check if a value is missing or invalid
            function isInvalidValue(topic, value) {
                if (INVALID_VALUES.includes(value)) {
                    debug(`Invalid value for ${topic}: ${value}`);
                    return true;
                }

                return false;
            }

            // Loop through the topics and store the values in node properties
            function setVariables(topics = [], obj = {}) {
                for (const t of topics) {
                    if (isInvalidValue(t, obj[t])) break;

                    const topicIndex = inverterTopics.indexOf(t);

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
            const requiredValues = [node.current_grid_1_power, node.current_grid_2_power, node.external_setpoint];

            // Check if all required values are available
            if (requiredValues.some((value) => INVALID_VALUES.includes(value))) {
                const missingCount = requiredValues.filter((value) => INVALID_VALUES.includes(value)).length;

                node.status({ fill: "yellow", shape: "dot", text: `Waiting for topics: ${missingCount}/3 (${ts.formatStatus()})` });
                return false;
            }

            // Additional check that export limits are negative and import limits are positive
            if (
                (node.max_grid_1_export !== null && node.max_grid_1_export > 0) ||
                (node.max_grid_2_export !== null && node.max_grid_2_export > 0) ||
                (node.max_inverter_export !== null && node.max_inverter_export > 0)
            ) {
                node.status({ fill: "red", shape: "dot", text: `Export limits must be <= 0 (${ts.formatStatus()})` });
                return false;
            }

            if (
                (node.max_grid_1_import !== null && node.max_grid_1_import < 0) ||
                (node.max_grid_2_import !== null && node.max_grid_2_import < 0) ||
                (node.max_inverter_import !== null && node.max_inverter_import < 0)
            ) {
                node.status({ fill: "red", shape: "dot", text: `Import limits must be >= 0 (${ts.formatStatus()})` });
                return false;
            }

            return true;
        }

        // Clean up on node removal
        node.on("close", function () {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-inverter-control-dual-limits", InverterControlDualLimitsNode);
};
