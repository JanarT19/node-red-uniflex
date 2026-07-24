const ts = require("../../core/lib/timestamp.js");
// uniflex-hp-error-manager.js
// Node-RED node: uniflex-hp-error-manager
// Purpose: Detect errors from multiple 16-bit Modbus DI registers and generate power break reset pulses to recover

module.exports = function (RED) {
    function HpErrorManagerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";

        // Error registers (DI type, topic without member - e.g., "ESER1W" not "ESER1W.1")
        node.errorTopic1 = config.errorTopic1 || "";
        node.errorTopic2 = config.errorTopic2 || "";
        node.errorTopic3 = config.errorTopic3 || "";
        node.errorTopic4 = config.errorTopic4 || "";

        // Bit exclusions per register (comma-separated bit numbers, e.g., "6,7" or "6")
        node.excludeBits1 = config.excludeBits1 || "";
        node.excludeBits2 = config.excludeBits2 || "";
        node.excludeBits3 = config.excludeBits3 || "";
        node.excludeBits4 = config.excludeBits4 || "";

        // Parse bit exclusions per register
        function parseExcludeBits(str) {
            if (!str || str.trim() === "") return [];
            return str
                .split(",")
                .map((s) => parseInt(s.trim()))
                .filter((n) => !isNaN(n) && n >= 0 && n < 16);
        }

        const excludedBitsPerRegister = {
            1: parseExcludeBits(node.excludeBits1),
            2: parseExcludeBits(node.excludeBits2),
            3: parseExcludeBits(node.excludeBits3),
            4: parseExcludeBits(node.excludeBits4)
        };

        // Timing
        node.errorDelaySec = Number(config.errorDelaySec ?? 10);
        node.resetTopic = config.resetTopic || "";
        node.resetPulseSec = Number(config.resetPulseSec ?? 10);
        node.minResetIntervalSec = Number(config.minResetIntervalSec ?? 3600);

        // ---- STATE
        // Store bit values per register: bitValues[topic][bit] = 0/1
        const bitValues = {}; // bitValues[topic][bit] = value (0 or 1)
        const errorCodes = {}; // errorCodes[topic] = combined 16-bit value
        let errorDetectedTs = null; // When error was first detected
        let resetActive = false; // Reset pulse currently active
        let resetStartTs = null; // When reset pulse started
        let lastResetTs = null; // When last reset completed
        let lastSentResetValue = null; // Track last sent reset value to avoid duplicate sends

        function nowSec() {
            return Math.floor(Date.now() / 1000);
        }

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        function formatErrorCode(code) {
            if (code === null || code === 0) return "0x0";
            // 16-bit register, max 0xFFFF
            const codeNum = Number(code) & 0xffff; // Mask to 16 bits
            return "0x" + codeNum.toString(16).toUpperCase().padStart(4, "0");
        }

        function formatHours(seconds) {
            if (seconds === null) return "N/A";
            const hours = (seconds / 3600).toFixed(2);
            return hours + "h";
        }

        // Combine bit values into 16-bit value for a topic
        function combineBits(topic) {
            if (!bitValues[topic]) return 0;

            let combined = 0;
            for (let bit = 0; bit < 16; bit++) {
                const bitValue = bitValues[topic][bit];
                if (bitValue === 1) {
                    combined |= 1 << bit;
                }
            }
            return combined & 0xffff; // Mask to 16 bits
        }

        // Exclude specified bits from error code for reset logic (per register)
        function excludeBits(code, registerNum) {
            // Mask to 16 bits
            let result = Number(code) & 0xffff;

            // Get excluded bits for this register
            const excluded = excludedBitsPerRegister[registerNum] || [];

            // Exclude each bit
            for (const bit of excluded) {
                if (bit >= 0 && bit < 16) {
                    result &= ~(1 << bit);
                }
            }

            return result;
        }

        // Check all error registers - returns true if ANY register has error (after bit exclusion)
        function hasError() {
            const registers = [
                { topic: node.errorTopic1, num: 1 },
                { topic: node.errorTopic2, num: 2 },
                { topic: node.errorTopic3, num: 3 },
                { topic: node.errorTopic4, num: 4 }
            ].filter((r) => r.topic);

            for (const { topic, num } of registers) {
                const code = errorCodes[topic];
                if (code !== null && code !== undefined) {
                    const codeNum = Number(code);
                    if (!isNaN(codeNum)) {
                        // Apply bit exclusions for this register and check if non-zero
                        const codeAfterExclusion = excludeBits(codeNum, num);
                        if (codeAfterExclusion !== 0) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        // Get all active errors with their register names
        function getActiveErrors() {
            const activeErrors = [];
            const registers = [
                { topic: node.errorTopic1, name: "1" },
                { topic: node.errorTopic2, name: "2" },
                { topic: node.errorTopic3, name: "3" },
                { topic: node.errorTopic4, name: "4" }
            ].filter((r) => r.topic);

            for (const { topic, name } of registers) {
                const code = errorCodes[topic];
                if (code !== null && code !== undefined) {
                    const codeNum = Number(code);
                    if (!isNaN(codeNum) && codeNum !== 0) {
                        activeErrors.push({ name, code: codeNum });
                    }
                }
            }

            return activeErrors;
        }

        // ---- RESET LOGIC
        function compute() {
            const tsnow = nowSec();

            // Check if we have at least one error register configured
            if (node.errorTopic1 === "") {
                setStatus("No error registers configured", "grey");
                if (node.resetTopic && lastSentResetValue !== 0) {
                    node.send({ topic: node.resetTopic, payload: 0 });
                    lastSentResetValue = 0;
                }
                return;
            }

            // Check if any register has error (after bit exclusion)
            const hasErr = hasError();

            // Track when error was first detected
            if (hasErr && errorDetectedTs === null) {
                errorDetectedTs = tsnow;
            } else if (!hasErr) {
                // Error cleared
                errorDetectedTs = null;
                if (resetActive) {
                    // Stop reset if error cleared
                    resetActive = false;
                    resetStartTs = null;
                    node.log("Error cleared, stopping reset");
                }
            }

            // Handle reset pulse duration
            if (resetActive && resetStartTs !== null) {
                if (tsnow - resetStartTs >= node.resetPulseSec) {
                    // Reset pulse completed
                    resetActive = false;
                    lastResetTs = tsnow;
                    resetStartTs = null;
                    node.log(`Reset pulse completed (${node.resetPulseSec}s)`);
                }
            }

            // Trigger reset if error persists after delay
            if (hasErr && errorDetectedTs !== null && tsnow - errorDetectedTs >= node.errorDelaySec && !resetActive) {
                // Check minimum interval since last reset
                if (lastResetTs === null || tsnow - lastResetTs >= node.minResetIntervalSec) {
                    // Start reset pulse
                    resetActive = true;
                    resetStartTs = tsnow;
                    const activeErrors = getActiveErrors();
                    const errorList = activeErrors.map((e) => `R${e.name}:${formatErrorCode(e.code)}`).join(" ");
                    node.warn(`Starting reset pulse due to persistent error: ${errorList}`);
                }
            }

            // Output reset signal (only when value changes)
            if (node.resetTopic) {
                const resetValue = resetActive ? 1 : 0;
                if (lastSentResetValue !== resetValue) {
                    node.send({ topic: node.resetTopic, payload: resetValue });
                    lastSentResetValue = resetValue;
                }
            }

            // Update status - show all error codes in hex
            const activeErrors = getActiveErrors();
            let statusText = "";
            if (activeErrors.length > 0) {
                const errorList = activeErrors.map((e) => `R${e.name}:${formatErrorCode(e.code)}`).join(" ");
                statusText = `Errors: ${errorList}`;
            } else {
                statusText = "No errors";
            }

            if (lastResetTs !== null) {
                const timeSinceReset = tsnow - lastResetTs;
                statusText += `, Last reset: ${formatHours(timeSinceReset)}`;
            }

            if (resetActive) {
                statusText += `, RESET`;
            }

            const fillColor = hasErr ? (resetActive ? "yellow" : "red") : "green";
            setStatus(statusText, fillColor);
        }

        // ---- INPUT HANDLER
        node.on("input", function (msg) {
            const topic = msg.topic || "";

            // Get all configured error topics (without members)
            const errorTopics = [node.errorTopic1, node.errorTopic2, node.errorTopic3, node.errorTopic4].filter((t) => t);

            // Check if this message is for one of our error topics
            // Topic can be exact match (e.g., "ESER1W") or with member (e.g., "ESER1W.1", "ESER1W.2")
            // Note: member numbers start from 1, member 1 = bit 0, member 2 = bit 1, etc.
            for (const baseTopic of errorTopics) {
                // Exact match or starts with baseTopic + "."
                if (topic === baseTopic || topic.startsWith(baseTopic + ".")) {
                    // Extract member if present (e.g., "ESER1W.5" -> member = 5, bit = 4)
                    let bit = null;
                    if (topic.startsWith(baseTopic + ".")) {
                        const memberStr = topic.substring(baseTopic.length + 1);
                        const memberNum = parseInt(memberStr);
                        // Convert member number to bit: member 1 = bit 0, member 2 = bit 1, etc.
                        if (!isNaN(memberNum) && memberNum >= 1 && memberNum <= 16) {
                            bit = memberNum - 1;
                        }
                    } else {
                        // No member - could be array of all bits
                        if (Array.isArray(msg.payload)) {
                            // Array of bit values [bit0, bit1, ..., bit15]
                            if (!bitValues[baseTopic]) {
                                bitValues[baseTopic] = {};
                            }
                            for (let i = 0; i < Math.min(16, msg.payload.length); i++) {
                                bitValues[baseTopic][i] = Number(msg.payload[i]) ? 1 : 0;
                            }
                            errorCodes[baseTopic] = combineBits(baseTopic);
                            compute();
                            return;
                        }
                    }

                    // Update bit value
                    if (bit !== null) {
                        if (!bitValues[baseTopic]) {
                            bitValues[baseTopic] = {};
                        }
                        const bitValue = Number(msg.payload) ? 1 : 0;
                        bitValues[baseTopic][bit] = bitValue;

                        // Recombine bits into 16-bit value
                        errorCodes[baseTopic] = combineBits(baseTopic);
                    } else if (topic === baseTopic) {
                        // Direct topic without member - treat as combined value
                        const newErrorCode = Number(msg.payload);
                        if (!isNaN(newErrorCode)) {
                            // Mask to 16 bits (0-65535)
                            const maskedCode = newErrorCode & 0xffff;
                            errorCodes[baseTopic] = maskedCode;
                            // Clear bit values since we have direct value
                            bitValues[baseTopic] = null;
                        } else {
                            errorCodes[baseTopic] = null;
                        }
                    }
                }
            }

            // Compute and publish
            compute();
        });

        // Periodic check (every second) to handle reset pulse timing
        const checkInterval = setInterval(() => {
            compute();
        }, 1000);

        // Cleanup on close
        node.on("close", function () {
            if (checkInterval) {
                clearInterval(checkInterval);
            }
        });

        // Initialize
        setStatus("Ready", "grey");
        compute();
    }

    RED.nodes.registerType("uniflex-hp-error-manager", HpErrorManagerNode);
};
