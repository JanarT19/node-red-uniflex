const ts = require("../../core/lib/timestamp.js");
// uniflex-level-controller.js
// Node-RED node: uniflex-level-controller
// Purpose: Orchestrate multiple pumps based on water level with safety interlocks and current limiting.

module.exports = function (RED) {
    function LevelControllerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.levelActualTopic = config.levelActualTopic || "";
        node.levelStartTopic = config.levelStartTopic || "";
        node.levelStopTopic = config.levelStopTopic || "";
        node.lowFloatTopic = config.lowFloatTopic || "";
        node.highFloatTopic = config.highFloatTopic || "";
        node.phaseCtrlTopic = config.phaseCtrlTopic || "";
        node.totalCurrentTopic = config.totalCurrentTopic || "";
        node.maxCurrentTopic = config.maxCurrentTopic || "";
        node.numPumps = parseInt(config.numPumps ?? 2);
        node.enableRotation = config.enableRotation !== false; // default true
        node.swapDelaySec = Number(config.swapDelaySec ?? 30);
        node.startDelaySec = Number(config.startDelaySec ?? 2.0); // Delay before checking NORUN after pump start
        node.maxPumpTimeSec = Number(config.maxPumpTimeSec ?? 600); // Maximum runtime before automatic swap (seconds)
        node.totalCurrentMeasured = config.totalCurrentMeasured !== false; // default true
        node.enableSystemLog = config.enableSystemLog === true; // default false
        // Level offset for starting 2nd pump (added to start level, null/undefined/empty = disabled)
        const levelStartPump2Val = config.levelStartPump2;
        node.levelStartPump2 = levelStartPump2Val !== null && levelStartPump2Val !== undefined && levelStartPump2Val !== "" ? Number(levelStartPump2Val) : null;

        // Parse pump fuse OFF topics (array format, or legacy comma-separated)
        // These indicate pump is unusable (fuse tripped or other problem)
        if (Array.isArray(config.pumpErrorTopics)) {
            node.pumpErrorTopics = config.pumpErrorTopics.filter((t) => t && t.length > 0);
        } else {
            node.pumpErrorTopics = (config.pumpErrorTopics || "")
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
        }

        // Parse pump command topics (array format, or legacy comma-separated)
        if (Array.isArray(config.pumpCmdTopics)) {
            node.pumpCmdTopics = config.pumpCmdTopics.filter((t) => t && t.length > 0);
        } else {
            node.pumpCmdTopics = (config.pumpCmdTopics || "")
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
        }

        // Parse pump NORUN topics (array format, or legacy comma-separated)
        if (Array.isArray(config.pumpNoRunTopics)) {
            node.pumpNoRunTopics = config.pumpNoRunTopics.filter((t) => t && t.length > 0);
        } else {
            node.pumpNoRunTopics = (config.pumpNoRunTopics || "")
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
        }

        // Parse pump overcurrent topics (array format, or legacy comma-separated)
        if (Array.isArray(config.pumpOvercurrentTopics)) {
            node.pumpOvercurrentTopics = config.pumpOvercurrentTopics.filter((t) => t && t.length > 0);
        } else {
            node.pumpOvercurrentTopics = (config.pumpOvercurrentTopics || "")
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
        }

        // Validate configuration
        if (node.pumpCmdTopics.length !== node.numPumps) {
            node.warn(`Number of command topics (${node.pumpCmdTopics.length}) does not match numPumps (${node.numPumps})`);
        }

        // ---- STATE
        let levelActual = null; // Actual water level (m)
        let levelStart = null; // Start threshold (m)
        let levelStop = null; // Stop threshold (m)
        let LES = null; // Low float: 0=OK, 1=triggered
        let LHS = null; // High float: 0=OK, 1=triggered
        let PWS = null; // Phase control: 0=OK, 1=fault
        let totalCurrent = null; // Total current (A) - only used if totalCurrentMeasured is true
        let maxCurrent = null; // Maximum allowed current (A) from iolayer - only used if totalCurrentMeasured is true

        // Cache for service unit (for status display only)
        let levelUnit = "m"; // default unit

        // Query controller configuration to get out_unit for status display
        function queryServiceConfig() {
            // Find all controller nodes and get unit for level topic
            RED.nodes.eachNode(function (n) {
                if (n.type === "uniflex-controller" && n.services) {
                    // Extract service key from level topic (remove .N suffix)
                    const serviceKey = node.levelActualTopic ? node.levelActualTopic.split(".")[0] : null;
                    if (serviceKey && n.services[serviceKey] && n.services[serviceKey].out_unit) {
                        levelUnit = n.services[serviceKey].out_unit;
                        node.debug(`Using unit '${levelUnit}' for level display`);
                    }
                }
            });
        }

        // Helper function to parse numeric value (handles comma or dot as decimal separator)
        // Values are already converted by read node, so just parse and return
        function parseLevelValue(val) {
            if (val === null || val === undefined) return null;
            // Convert to string and replace comma with dot for parsing
            const str = String(val).replace(",", ".");
            const num = Number(str);
            if (isNaN(num)) return null;
            // Value is already in correct unit (read node converted it), use as-is
            return num;
        }

        // Helper function for system logging
        function systemLog(level, message) {
            if (node.enableSystemLog) {
                // Use RED.log for system logging (can be extended to use settings.js configuration)
                if (RED && RED.log) {
                    RED.log[level](message);
                } else {
                    // Fallback to console if RED.log not available
                    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${node.name || "level-controller"}] ${message}`);
                }
            }
        }

        // Pump states
        let pumpCommands = Array(node.numPumps).fill(0); // 0=stop, 1=start
        let pumpErrors = Array(node.numPumps).fill(0); // 0=OK, 1=fuse OFF/problem (pump unusable)
        let pumpNoRun = Array(node.numPumps).fill(0); // 0=OK, 1=NORUN error
        let pumpOvercurrent = Array(node.numPumps).fill(0); // 0=OK, 1=overcurrent error
        let pumpStartTime = Array(node.numPumps).fill(0); // timestamp of last start (for start delay)
        let pumpNoRunStartTime = Array(node.numPumps).fill(0); // timestamp when NORUN was first detected
        let pumpSwapTimers = Array(node.numPumps).fill(null); // timers for swap on error
        let pumpMaxTimeTimers = Array(node.numPumps).fill(null); // timers for max runtime swap
        let rotationIndex = 0; // for pump rotation

        function updateStatus() {
            let parts = [];
            let warnings = [];

            // Calculate active pumps once
            const activePumps = pumpCommands.filter((cmd) => cmd === 1).length;

            // Level validation - all 3 values must exist
            const levelValid = levelActual !== null && levelStart !== null && levelStop !== null;

            // Level (always show if available, or show warning if missing)
            if (levelActual !== null) {
                parts.push(`L=${levelActual.toFixed(3)}${levelUnit}`);
            } else {
                parts.push("L=---");
            }

            // Warn if level data is incomplete
            if (!levelValid) {
                const missing = [];
                if (levelActual === null) missing.push("actual");
                if (levelStart === null) missing.push("start");
                if (levelStop === null) missing.push("stop");
                warnings.push(`LVL?(${missing.join(",")})`);
            }

            // Active pumps (show only if running)
            if (activePumps > 0) {
                const activeIndices = pumpCommands.map((cmd, idx) => (cmd === 1 ? idx + 1 : null)).filter((idx) => idx !== null);
                parts.push(`P${activeIndices.join(",")}`);
            }

            // Total current (if configured and total current measured)
            if (node.totalCurrentMeasured && totalCurrent !== null && node.totalCurrentTopic) {
                if (activePumps > 0 && maxCurrent !== null) {
                    const currentPerPump = totalCurrent / activePumps;
                    parts.push(`${totalCurrent.toFixed(1)}A (${currentPerPump.toFixed(1)}A/pump)`);
                } else {
                    parts.push(`${totalCurrent.toFixed(1)}A`);
                }
            }

            // Warnings only (show only if not 0)
            if (LES === 1) warnings.push("LES!");
            if (LHS === 1) warnings.push("LHS!");
            if (PWS === 1) warnings.push("PWS!");

            // Check overcurrent per pump (only if total current measured)
            if (node.totalCurrentMeasured && maxCurrent !== null && totalCurrent !== null && activePumps > 0) {
                const currentPerPump = totalCurrent / activePumps;
                if (currentPerPump > maxCurrent) {
                    warnings.push(`OC! (${currentPerPump.toFixed(1)}A/pump)`);
                }
            }

            // Pump fuse OFF states
            const errorPumps = pumpErrors.map((err, idx) => (err === 1 ? idx + 1 : null)).filter((idx) => idx !== null);
            if (errorPumps.length > 0) {
                warnings.push(`P${errorPumps.join(",")}FUSE`);
            }

            const statusText = parts.length > 0 ? parts.concat(warnings).join(" ") : "Waiting for level...";

            // Determine color
            let fill = "grey";
            if (LES === 1 || PWS === 1) {
                fill = "red"; // critical safety interlock
            } else if (warnings.length > 0) {
                fill = "orange"; // warnings (including missing level data)
            } else if (activePumps > 0) {
                fill = "green"; // pumps running
            } else if (levelActual !== null) {
                fill = "blue"; // level available, pumps stopped
            } else if (!levelValid) {
                fill = "yellow"; // missing level data
            }

            node.status({ fill, shape: "dot", text: statusText });
        }

        // Query service configuration on initialization (for unit display)
        queryServiceConfig();

        updateStatus();

        // ---- PUMP CONTROL LOGIC
        function checkPumpControl() {
            // Check if we have all required level data - CRITICAL: no pump control without all 3 values
            if (levelActual === null || levelStart === null || levelStop === null) {
                // Stop any running pumps if level data is incomplete
                const activePumps = pumpCommands.filter((cmd) => cmd === 1).length;
                if (activePumps > 0) {
                    const missing = [];
                    if (levelActual === null) missing.push("actual");
                    if (levelStart === null) missing.push("start");
                    if (levelStop === null) missing.push("stop");
                    const msg = `EMERGENCY STOP: Missing level data (${missing.join(", ")})`;
                    node.error(msg);
                    systemLog("error", msg);

                    for (let i = 0; i < node.numPumps; i++) {
                        if (pumpCommands[i] === 1) {
                            stopPump(i);
                        }
                    }
                }
                updateStatus();
                return;
            }

            // Calculate active pumps once (needed for validation and logging)
            const activePumps = pumpCommands.filter((cmd) => cmd === 1).length;

            // Ensure all level values are numbers (defensive check)
            const actual = Number(levelActual);
            const start = Number(levelStart);
            const stop = Number(levelStop);

            // Validate that conversion was successful
            if (isNaN(actual) || isNaN(start) || isNaN(stop)) {
                const msg = `Invalid level values: actual=${levelActual} (${typeof levelActual}), start=${levelStart} (${typeof levelStart}), stop=${levelStop} (${typeof levelStop})`;
                node.warn(msg);
                systemLog("warn", msg);
                updateStatus();
                return;
            }

            // Log level check only when band or pump state changes (avoids spam when idle and actual drifts 0.55/0.56)
            const band = actual < stop ? "below" : actual > start ? "above" : "between";
            const currentState = activePumps === 0 ? `idle_${band}` : `active_${band}_${activePumps}_${pumpCommands.join("")}`;
            if (!node.lastLoggedState || node.lastLoggedState !== currentState) {
                node.lastLoggedState = currentState;
                const pumpStates = pumpCommands.map((cmd, idx) => `P${idx + 1}=${cmd ? "ON" : "OFF"}`).join(" ");
                const msg = `Level check: actual=${actual}, start=${start}, stop=${stop}, activePumps=${activePumps} [${pumpStates}], comparison: ${actual} > ${start} = ${actual > start}`;
                node.log(msg);
                systemLog("info", msg);
            }

            // Safety checks
            const lowFloatOK = LES === null || LES === 0;
            const phaseOK = PWS === null || PWS === 0;

            // Check current per pump (if total current measured and both current and limit available)
            let currentOK = true;
            let currentPerPump = 0;
            if (node.totalCurrentMeasured && maxCurrent !== null && totalCurrent !== null && activePumps > 0) {
                currentPerPump = totalCurrent / activePumps;
                currentOK = currentPerPump < maxCurrent;
            }

            // Check if any pump should stop
            const shouldStopAll = !lowFloatOK || !phaseOK || !currentOK;

            if (shouldStopAll) {
                // Emergency stop all pumps
                let reason = [];
                if (!lowFloatOK) reason.push("LES");
                if (!phaseOK) reason.push("PWS");
                if (!currentOK && maxCurrent !== null) {
                    reason.push(`OC(${currentPerPump.toFixed(1)}A/pump > ${maxCurrent.toFixed(1)}A)`);
                }

                for (let i = 0; i < node.numPumps; i++) {
                    if (pumpCommands[i] === 1) {
                        const msg = `EMERGENCY STOP pump ${i + 1}: ${reason.join(", ")}`;
                        node.log(msg);
                        systemLog("warn", msg);
                        stopPump(i);
                    }
                }
                updateStatus();
                return;
            }

            // Check level-based control

            // STOP condition: level below stop threshold
            if (actual < stop && activePumps > 0) {
                // Stop all pumps
                for (let i = 0; i < node.numPumps; i++) {
                    if (pumpCommands[i] === 1) {
                        const msg = `Stopping pump ${i + 1}: level ${actual} < ${stop}`;
                        node.log(msg);
                        systemLog("info", msg);
                        stopPump(i);
                    }
                }
            }

            // START condition: level above start threshold
            if (actual > start && activePumps === 0) {
                // Start first pump when level exceeds start threshold
                const pumpIdx = selectPumpToStart();

                if (pumpIdx !== -1) {
                    const msg = `Starting pump ${pumpIdx + 1}: level ${actual} > ${start}`;
                    node.log(msg);
                    systemLog("info", msg);
                    startPump(pumpIdx);
                } else {
                    // Log why no pump can start (only if system logging enabled to avoid spam)
                    if (node.enableSystemLog) {
                        const msg = `Cannot start any pump: all have fuse OFF or already running`;
                        node.warn(msg);
                        systemLog("warn", msg);
                    } else {
                        // Even without system logging, log at debug level to help diagnose
                        node.debug(`Cannot start pump: selectPumpToStart() returned -1`);
                    }
                }
            } else if (actual > start && activePumps === 1 && node.levelStartPump2 !== null && node.levelStartPump2 !== "" && !isNaN(Number(node.levelStartPump2))) {
                // Start second pump if level exceeds start level + offset
                const secondPumpThreshold = start + Number(node.levelStartPump2);
                if (actual > secondPumpThreshold) {
                    const pumpIdx = selectPumpToStart();

                    if (pumpIdx !== -1) {
                        const msg = `Starting pump ${pumpIdx + 1}: level ${actual} > ${secondPumpThreshold} (start ${start} + offset ${node.levelStartPump2})`;
                        node.log(msg);
                        systemLog("info", msg);
                        startPump(pumpIdx);
                    } else {
                        if (node.enableSystemLog) {
                            const msg = `Cannot start 2nd pump: all have fuse OFF or already running`;
                            node.warn(msg);
                            systemLog("warn", msg);
                        }
                    }
                } else {
                    // Don't log - threshold not met is normal, only log when it changes
                }
            } else if (activePumps > 0 && actual <= start) {
                // Safety check: if pumps are running but level is at or below start, log warning
                // Only log once per state change to avoid spam
                const warningState = `warning_${activePumps}_${actual.toFixed(2)}_${start.toFixed(2)}`;
                if (!node.lastWarningState || node.lastWarningState !== warningState) {
                    node.lastWarningState = warningState;
                    const msg = `WARNING: Pumps running but level ${actual} <= start ${start}`;
                    node.warn(msg);
                    systemLog("warn", msg);
                }
            } else {
                // Clear warning state when condition no longer applies
                node.lastWarningState = null;
            }

            updateStatus();
            checkPumpSwapErrors(); // Check for swap conditions after control logic
        }

        function selectPumpToStart() {
            // Select pump based on rotation and availability
            for (let attempt = 0; attempt < node.numPumps; attempt++) {
                let pumpIdx;

                if (node.enableRotation) {
                    // Try pumps in rotation order
                    pumpIdx = (rotationIndex + attempt) % node.numPumps;
                } else {
                    // Always try pumps in order 0, 1, 2...
                    pumpIdx = attempt;
                }

                // Check if pump is available (no fuse OFF, not already running)
                const hasFuseOFF = pumpErrors[pumpIdx] === 1;
                const isNotRunning = pumpCommands[pumpIdx] === 0;

                if (node.enableSystemLog && (hasFuseOFF || !isNotRunning)) {
                    const reasons = [];
                    if (hasFuseOFF) reasons.push("fuse OFF");
                    if (!isNotRunning) reasons.push("already running");
                    node.debug(`Pump ${pumpIdx + 1} unavailable: ${reasons.join(", ")}`);
                }

                if (!hasFuseOFF && isNotRunning) {
                    // Update rotation index for next start
                    if (node.enableRotation) {
                        rotationIndex = (pumpIdx + 1) % node.numPumps;
                    }
                    return pumpIdx;
                }
            }

            // No pump available - log why if system logging enabled
            if (node.enableSystemLog) {
                const allReasons = [];
                for (let i = 0; i < node.numPumps; i++) {
                    const reasons = [];
                    if (pumpErrors[i] === 1) reasons.push("fuse OFF");
                    if (pumpCommands[i] === 1) reasons.push("already running");
                    if (reasons.length > 0) {
                        allReasons.push(`P${i + 1}: ${reasons.join(", ")}`);
                    }
                }
                if (allReasons.length > 0) {
                    node.debug(`No pump available: ${allReasons.join("; ")}`);
                }
            }

            return -1;
        }

        function startPump(pumpIdx) {
            if (pumpIdx < 0 || pumpIdx >= node.numPumps) {
                node.warn(`Invalid pump index ${pumpIdx} in startPump()`);
                return;
            }

            // Prevent starting a pump that's already commanded ON
            if (pumpCommands[pumpIdx] === 1) {
                node.debug(`Pump ${pumpIdx + 1} already commanded ON, skipping duplicate start`);
                return;
            }

            pumpCommands[pumpIdx] = 1;
            pumpStartTime[pumpIdx] = Date.now(); // Record start time for start delay

            // Clear swap timer when starting a pump
            if (pumpSwapTimers[pumpIdx]) {
                clearTimeout(pumpSwapTimers[pumpIdx]);
                pumpSwapTimers[pumpIdx] = null;
            }

            // Clear max time timer when starting a pump
            if (pumpMaxTimeTimers[pumpIdx]) {
                clearTimeout(pumpMaxTimeTimers[pumpIdx]);
                pumpMaxTimeTimers[pumpIdx] = null;
            }

            // Clear NORUN start time when starting a pump (NORUN will be cleared by pump node if feedback arrives)
            // But don't clear if fuse is OFF - pump shouldn't start anyway
            if (pumpErrors[pumpIdx] !== 1) {
                pumpNoRunStartTime[pumpIdx] = 0; // Reset NORUN tracking on new start attempt
            }

            // Start max time timer for automatic swap after maxPumpTimeSec
            pumpMaxTimeTimers[pumpIdx] = setTimeout(() => {
                pumpMaxTimeTimers[pumpIdx] = null;

                // Check if pump is still running
                if (pumpCommands[pumpIdx] === 1) {
                    const msg = `Pump ${pumpIdx + 1} max runtime (${node.maxPumpTimeSec}s) reached - swapping pump`;
                    node.log(msg);
                    systemLog("info", msg);

                    // Stop the pump that has run for max time
                    stopPump(pumpIdx);

                    // Had active cmd → move to another pump if available (no level check)
                    const newPumpIdx = selectPumpToStart();
                    if (newPumpIdx !== -1) {
                        const msg2 = `Starting replacement pump ${newPumpIdx + 1} after max time swap (moving active cmd)`;
                        node.log(msg2);
                        systemLog("info", msg2);
                        startPump(newPumpIdx);
                    } else {
                        const msg2 = `Cannot start replacement pump after max time swap: no available pumps`;
                        node.warn(msg2);
                        systemLog("warn", msg2);
                    }
                }
            }, node.maxPumpTimeSec * 1000);

            sendPumpCommand(pumpIdx, 1);
        }

        function checkPumpSwapErrors() {
            // Check each pump for NORUN or overcurrent errors
            // Only process swap logic for pumps that are actually running
            const now = Date.now();
            for (let i = 0; i < node.numPumps; i++) {
                if (pumpCommands[i] === 1) {
                    // Pump is commanded ON
                    const startDelayElapsed = now - pumpStartTime[i] >= node.startDelaySec * 1000;
                    const hasError = pumpNoRun[i] === 1 || pumpOvercurrent[i] === 1;

                    // For NORUN: swap after startDelay + errorDelay (errorDelay is typically 1s, from pump node)
                    // For overcurrent: swap immediately (or after swapDelay if configured)
                    let shouldSwap = false;
                    let swapDelay = node.swapDelaySec * 1000;

                    if (pumpNoRun[i] === 1 && startDelayElapsed) {
                        // NORUN detected - check if it's been active for errorDelay (default 1s from pump node)
                        // We use a fixed 1s error delay for NORUN swap (matching typical pump node errorDelaySec)
                        const errorDelayMs = 1000; // 1 second error delay for NORUN
                        const noRunDuration = pumpNoRunStartTime[i] > 0 ? now - pumpNoRunStartTime[i] : now - pumpStartTime[i] - node.startDelaySec * 1000;
                        if (noRunDuration >= errorDelayMs) {
                            shouldSwap = true;
                            swapDelay = 0; // Swap immediately if error delay has elapsed
                        }
                    } else if (pumpOvercurrent[i] === 1) {
                        // Overcurrent - swap after swapDelay
                        shouldSwap = true;
                        swapDelay = node.swapDelaySec * 1000;
                    }

                    if (shouldSwap && !pumpSwapTimers[i]) {
                        // Start swap timer
                        const errorType = pumpNoRun[i] === 1 ? "NORUN" : "overcurrent";
                        const delayStr = swapDelay > 0 ? ` after ${swapDelay / 1000}s` : " immediately";
                        node.warn(`Pump ${i + 1} error detected (${errorType}), will swap${delayStr}`);
                        systemLog("warn", `Pump ${i + 1} error detected (${errorType}), will swap${delayStr}`);
                        pumpSwapTimers[i] = setTimeout(() => {
                            pumpSwapTimers[i] = null;

                            // Check if error still exists and pump is still running
                            if (pumpCommands[i] === 1 && (pumpNoRun[i] === 1 || pumpOvercurrent[i] === 1)) {
                                node.error(`Pump ${i + 1} swap: error persists, swapping pump`);

                                // Stop the faulty pump
                                stopPump(i);

                                // Had active cmd → move to another pump if available (no level check)
                                const newPumpIdx = selectPumpToStart();
                                if (newPumpIdx !== -1) {
                                    const msg = `Starting replacement pump ${newPumpIdx + 1} after NORUN/overcurrent swap (moving active cmd)`;
                                    node.log(msg);
                                    systemLog("info", msg);
                                    startPump(newPumpIdx);
                                } else {
                                    const msg = `Cannot start replacement pump: all have fuse OFF or already running`;
                                    node.warn(msg);
                                    systemLog("warn", msg);
                                }
                            }
                        }, swapDelay);
                    } else if (!hasError && pumpSwapTimers[i]) {
                        // Clear swap timer if error cleared
                        clearTimeout(pumpSwapTimers[i]);
                        pumpSwapTimers[i] = null;
                        node.log(`Pump ${i + 1} error cleared, swap cancelled`);
                    }
                } else {
                    // Pump is not running, clear swap timer
                    if (pumpSwapTimers[i]) {
                        clearTimeout(pumpSwapTimers[i]);
                        pumpSwapTimers[i] = null;
                    }
                }
            }
        }

        function stopPump(pumpIdx) {
            if (pumpIdx < 0 || pumpIdx >= node.numPumps) return;

            pumpCommands[pumpIdx] = 0;

            // Clear swap timer if pump is stopped
            if (pumpSwapTimers[pumpIdx]) {
                clearTimeout(pumpSwapTimers[pumpIdx]);
                pumpSwapTimers[pumpIdx] = null;
            }

            // Clear max time timer if pump is stopped
            if (pumpMaxTimeTimers[pumpIdx]) {
                clearTimeout(pumpMaxTimeTimers[pumpIdx]);
                pumpMaxTimeTimers[pumpIdx] = null;
            }

            sendPumpCommand(pumpIdx, 0);
        }

        function sendPumpCommand(pumpIdx, value) {
            if (pumpIdx < 0 || pumpIdx >= node.pumpCmdTopics.length) {
                node.warn(`Cannot send command to pump ${pumpIdx + 1}: topic not configured`);
                return;
            }

            // Send message with the pump's command topic
            // With a single output, all pumps receive all messages and filter by topic
            const msg = {
                topic: node.pumpCmdTopics[pumpIdx],
                payload: value,
                cmd: value // also include cmd for direct pump node connection (fallback)
            };

            // Log which topic is being sent (for debugging)
            if (node.enableSystemLog) {
                node.debug(`Sending command: topic=${node.pumpCmdTopics[pumpIdx]}, value=${value}`);
            }

            node.send(msg);
            const cmdStr = value === 1 ? "START" : "STOP";
            const logMsg = `Pump ${pumpIdx + 1} command → ${cmdStr} (topic: ${node.pumpCmdTopics[pumpIdx]}, payload: ${value})`;
            node.log(logMsg);
            systemLog("info", logMsg);
        }

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = msg.payload;

            // Water level - actual (AI)
            if (t === node.levelActualTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const parsed = parseLevelValue(val);
                if (parsed === null) {
                    node.warn(`Invalid level actual value: ${val} (topic: ${t})`);
                } else {
                    levelActual = parsed;
                    checkPumpControl();
                }
                return;
            }

            // Water level - start threshold (AI)
            if (t === node.levelStartTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const parsed = parseLevelValue(val);
                if (parsed === null) {
                    node.warn(`Invalid level start value: ${val} (topic: ${t})`);
                } else {
                    // Only log if value actually changed
                    if (levelStart === null || Math.abs(levelStart - parsed) > 0.001) {
                        levelStart = parsed;
                        const msg = `Start threshold updated: ${levelStart.toFixed(3)}${levelUnit}`;
                        node.log(msg);
                        systemLog("info", msg);
                    } else {
                        levelStart = parsed; // Update even if same (for consistency)
                    }
                    checkPumpControl();
                }
                return;
            }

            // Water level - stop threshold (AI)
            if (t === node.levelStopTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const parsed = parseLevelValue(val);
                if (parsed === null) {
                    node.warn(`Invalid level stop value: ${val} (topic: ${t})`);
                } else {
                    // Only log if value actually changed
                    if (levelStop === null || Math.abs(levelStop - parsed) > 0.001) {
                        levelStop = parsed;
                        const msg = `Stop threshold updated: ${levelStop.toFixed(3)}${levelUnit}`;
                        node.log(msg);
                        systemLog("info", msg);
                    } else {
                        levelStop = parsed; // Update even if same (for consistency)
                    }
                    checkPumpControl();
                }
                return;
            }

            // Low float switch (DI)
            if (t === node.lowFloatTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const newLES = Number(val);

                if (newLES !== LES) {
                    LES = newLES;
                    if (LES === 1) {
                        const msg = `LOW FLOAT TRIGGERED - emergency stop all pumps`;
                        node.error(msg);
                        systemLog("error", msg);
                    } else {
                        const msg = `Low float cleared`;
                        node.log(msg);
                        systemLog("info", msg);
                    }
                }
                checkPumpControl();
                return;
            }

            // High float switch (DI)
            if (t === node.highFloatTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                LHS = Number(val);
                checkPumpControl();
                return;
            }

            // Phase control (DI)
            if (t === node.phaseCtrlTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const newPWS = Number(val);

                if (newPWS !== PWS) {
                    PWS = newPWS;
                    if (PWS === 1) {
                        const msg = `PHASE CONTROL FAULT - stop all pumps`;
                        node.error(msg);
                        systemLog("error", msg);
                    } else {
                        const msg = `Phase control OK`;
                        node.log(msg);
                        systemLog("info", msg);
                    }
                }
                checkPumpControl();
                return;
            }

            // Total current (AI)
            if (t === node.totalCurrentTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                totalCurrent = Number(val);

                // Check for overcurrent (per pump)
                const activePumps = pumpCommands.filter((cmd) => cmd === 1).length;
                if (maxCurrent !== null && activePumps > 0) {
                    const currentPerPump = totalCurrent / activePumps;
                    if (currentPerPump > maxCurrent) {
                        node.warn(
                            `Current per pump ${currentPerPump.toFixed(1)}A exceeds limit ${maxCurrent.toFixed(1)}A (total: ${totalCurrent.toFixed(1)}A / ${activePumps} pumps)`
                        );
                    }
                }

                checkPumpControl();
                return;
            }

            // Max current limit (from iolayer) - PER PUMP - only process if total current measured
            if (node.totalCurrentMeasured && t === node.maxCurrentTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                maxCurrent = Number(val);
                const msg = `Max current limit per pump updated: ${maxCurrent.toFixed(1)}A`;
                node.log(msg);
                systemLog("info", msg);
                checkPumpControl();
                return;
            }

            // Pump fuse OFF inputs (from iolayer)
            // Input: 0=OK, 1=fuse OFF/problem (pump unusable)
            for (let i = 0; i < node.pumpErrorTopics.length && i < node.numPumps; i++) {
                if (t === node.pumpErrorTopics[i]) {
                    const val = Array.isArray(p) ? p[0] : p;
                    const newFuseOFF = Number(val);

                    if (newFuseOFF !== pumpErrors[i]) {
                        pumpErrors[i] = newFuseOFF;

                        if (newFuseOFF === 1) {
                            node.warn(`Pump ${i + 1} fuse OFF detected - pump unusable`);

                            // Stop pump if it's running and move active command to another pump if one exists
                            if (pumpCommands[i] === 1) {
                                node.log(`Stopping pump ${i + 1} due to fuse OFF`);
                                stopPump(i);
                                // Had active cmd → move to another pump if available (no level check)
                                const replacementPumpIdx = selectPumpToStart();
                                if (replacementPumpIdx !== -1 && replacementPumpIdx !== i) {
                                    const msg = `Starting replacement pump ${replacementPumpIdx + 1} after pump ${i + 1} fuse OFF (moving active cmd)`;
                                    node.log(msg);
                                    systemLog("info", msg);
                                    startPump(replacementPumpIdx);
                                } else if (replacementPumpIdx === -1) {
                                    const msg = `Cannot start replacement pump after pump ${i + 1} fuse OFF: no available pumps`;
                                    node.warn(msg);
                                    systemLog("warn", msg);
                                }
                            }
                        } else {
                            node.log(`Pump ${i + 1} fuse OFF cleared`);
                        }
                    }

                    updateStatus();
                    return;
                }
            }

            // Pump NORUN topics (from pump nodes)
            for (let i = 0; i < node.pumpNoRunTopics.length && i < node.numPumps; i++) {
                if (t === node.pumpNoRunTopics[i]) {
                    const val = Array.isArray(p) ? p[0] : p;
                    const newNoRun = Number(val);

                    if (newNoRun !== pumpNoRun[i]) {
                        pumpNoRun[i] = newNoRun;
                        if (newNoRun === 1) {
                            // Record when NORUN was first detected (for error delay tracking)
                            if (pumpNoRunStartTime[i] === 0) {
                                pumpNoRunStartTime[i] = Date.now();
                            }
                            node.warn(`Pump ${i + 1} NORUN detected`);
                        } else {
                            // NORUN cleared - reset tracking time
                            pumpNoRunStartTime[i] = 0;
                            node.log(`Pump ${i + 1} NORUN cleared`);
                        }
                        checkPumpSwapErrors();
                        updateStatus();
                    }
                    return;
                }
            }

            // Pump overcurrent topics (from pump nodes)
            for (let i = 0; i < node.pumpOvercurrentTopics.length && i < node.numPumps; i++) {
                if (t === node.pumpOvercurrentTopics[i]) {
                    const val = Array.isArray(p) ? p[0] : p;
                    const newOvercurrent = Number(val);

                    if (newOvercurrent !== pumpOvercurrent[i]) {
                        pumpOvercurrent[i] = newOvercurrent;
                        if (newOvercurrent === 1) {
                            node.error(`Pump ${i + 1} overcurrent detected`);
                        } else {
                            node.log(`Pump ${i + 1} overcurrent cleared`);
                        }
                        checkPumpSwapErrors();
                        updateStatus();
                    }
                    return;
                }
            }
        });

        node.on("close", () => {
            // Clear all swap timers
            for (let i = 0; i < node.numPumps; i++) {
                if (pumpSwapTimers[i]) {
                    clearTimeout(pumpSwapTimers[i]);
                    pumpSwapTimers[i] = null;
                }
                if (pumpMaxTimeTimers[i]) {
                    clearTimeout(pumpMaxTimeTimers[i]);
                    pumpMaxTimeTimers[i] = null;
                }
            }

            // Stop all pumps on close
            for (let i = 0; i < node.numPumps; i++) {
                if (pumpCommands[i] === 1) {
                    stopPump(i);
                }
            }
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-level-controller", LevelControllerNode);
};
