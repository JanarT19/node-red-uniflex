const ts = require("../../core/lib/timestamp.js");
// uniflex-arithmetics.js
// Node-RED node: uniflex-arithmetics
// Purpose: Combine up to 16 topic values with +, -, *, / operations.
// Uses dynamic editable list for inputs, with timeout-based caching.

module.exports = function (RED) {
    function ArithmeticsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.outputTopic = config.outputTopic || "";
        node.outputInt = config.outputInt === true;
        node.enableSystemLog = config.enableSystemLog === true;
        node.inputTimeout = parseInt(config.inputTimeout, 10) || 300; // seconds

        // Parse inputs array from config (renamed from "inputs" to avoid Node-RED conflict)
        // Each input: { topic: string, operator: string }
        // First input's operator is ignored (it's the base value)
        const inputsList = Array.isArray(config.inputsList) ? config.inputsList : [];

        // ---- STATE
        // topic -> { value: number, timestamp: number (ms) }
        const valueCache = {};
        let lastResult = null;
        let statusTimer = null;

        function systemLog(level, message) {
            if (node.enableSystemLog && RED && RED.log && RED.log[level]) {
                RED.log[level](message);
            }
        }

        function getConfiguredInputs() {
            return inputsList
                .filter((inp) => inp && inp.topic && inp.topic.length > 0)
                .map((inp) => ({
                    topic: inp.topic,
                    operator: inp.operator || "+"
                }));
        }

        function isStale(timestamp) {
            if (!timestamp) return true;
            const ageMs = Date.now() - timestamp;
            return ageMs > node.inputTimeout * 1000;
        }

        function getStaleInputs() {
            const configured = getConfiguredInputs();
            const stale = [];
            for (const inp of configured) {
                const cached = valueCache[inp.topic];
                if (!cached || isStale(cached.timestamp)) {
                    stale.push(inp.topic);
                }
            }
            return stale;
        }

        function applyOp(acc, op, val) {
            switch (op) {
                case "+":
                    return acc + val;
                case "-":
                    return acc - val;
                case "*":
                    return acc * val;
                case "/":
                    if (val === 0) {
                        throw new Error("Division by zero");
                    }
                    return acc / val;
                default:
                    throw new Error(`Unknown operator: ${op}`);
            }
        }

        function evaluate() {
            const configured = getConfiguredInputs();
            if (configured.length < 1) {
                return null;
            }

            // Check all inputs have values (cached, may be stale)
            for (const inp of configured) {
                const cached = valueCache[inp.topic];
                if (!cached || typeof cached.value !== "number") {
                    return null; // missing operand → wait
                }
            }

            try {
                // First input is the base value
                let result = valueCache[configured[0].topic].value;

                // Apply subsequent operators: result = result op value
                for (let i = 1; i < configured.length; i++) {
                    const inp = configured[i];
                    const val = valueCache[inp.topic].value;
                    result = applyOp(result, inp.operator, val);
                }

                if (typeof result !== "number" || isNaN(result)) {
                    node.warn(`Arithmetics produced invalid result: ${result}`);
                    return null;
                }

                if (node.outputInt) {
                    result = Math.round(result);
                } else {
                    result = parseFloat(result.toFixed(4));
                }

                return result;
            } catch (e) {
                node.warn(`Arithmetics error: ${e.message}`);
                systemLog("warn", `[arithmetics:${node.name || "unnamed"}] ${e.message}`);
                return null;
            }
        }

        function updateStatus() {
            const configured = getConfiguredInputs();
            if (configured.length === 0) {
                node.status({ fill: "grey", shape: "dot", text: "No inputs configured" });
                return;
            }

            // Check which inputs are missing (never received)
            const missing = configured.filter((inp) => !valueCache[inp.topic]);
            if (missing.length > 0) {
                node.status({ fill: "grey", shape: "dot", text: `Waiting: ${missing.length}/${configured.length} missing` });
                return;
            }

            // Check which inputs are stale
            const stale = getStaleInputs();

            if (lastResult === null || lastResult === undefined) {
                node.status({ fill: "yellow", shape: "dot", text: "Waiting for valid result" });
            } else if (stale.length > 0) {
                const resultStr = node.outputInt ? String(lastResult) : lastResult.toFixed(2);
                node.status({ fill: "yellow", shape: "ring", text: `${stale.length} stale | ${resultStr}` });
            } else {
                const resultStr = node.outputInt ? String(lastResult) : lastResult.toFixed(2);
                node.status({ fill: "green", shape: "dot", text: `${configured.length} inputs = ${resultStr}` });
            }
        }

        function scheduleStatusUpdate() {
            // Periodically check for stale inputs
            if (statusTimer) {
                clearTimeout(statusTimer);
            }
            // Check every 30 seconds for stale status updates
            statusTimer = setTimeout(() => {
                updateStatus();
                scheduleStatusUpdate();
            }, 30000);
        }

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const configured = getConfiguredInputs();
            const topics = configured.map((inp) => inp.topic);

            if (!topics.includes(t)) {
                return; // ignore unrelated topics
            }

            let val = msg.payload;
            if (Array.isArray(val) && val.length > 0) {
                val = val[0];
            }
            val = Number(val);
            if (isNaN(val)) {
                node.warn(`Invalid numeric value from topic ${t}: ${JSON.stringify(msg.payload)}`);
                return;
            }

            // Cache value with timestamp
            valueCache[t] = {
                value: val,
                timestamp: Date.now()
            };

            const result = evaluate();
            if (result !== null && result !== undefined) {
                lastResult = result;
                const outTopic = node.outputTopic || t;
                const outMsg = {
                    topic: outTopic,
                    payload: result
                };
                node.send(outMsg);
            }

            updateStatus();
        });

        node.on("close", () => {
            if (statusTimer) {
                clearTimeout(statusTimer);
                statusTimer = null;
            }
            node.status({});
        });

        // Initial status
        updateStatus();
        scheduleStatusUpdate();
    }

    RED.nodes.registerType("uniflex-arithmetics", ArithmeticsNode);
};
