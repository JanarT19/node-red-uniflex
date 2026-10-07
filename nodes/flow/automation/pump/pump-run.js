// uniflex-pump.js
// Node-RED node: uniflex-pump
// Purpose: Manage individual pump with feedback monitoring, error detection, and runtime tracking.

const fs = require("fs");
const path = require("path");
const ts = require("../../core/lib/timestamp.js");

module.exports = function (RED) {
    function PumpNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";
        node.pumpCmdInputTopic = config.pumpCmdInputTopic || ""; // Input topic for commands from level controller
        node.pumpCmdTopic = config.pumpCmdTopic || "";
        node.feedbackType = config.feedbackType || "discrete"; // "discrete" or "current"
        node.pumpFeedbackTopic = config.pumpFeedbackTopic || "";
        node.pumpCurrentTopic = config.pumpCurrentTopic || "";
        node.currentLoLimit = Number(config.currentLoLimit ?? 1.0); // Lower threshold for current mode
        node.fuseOFFTopic = config.fuseOFFTopic || "";
        node.pumpErrorTopic = config.pumpErrorTopic || "";
        node.noRunTopic = config.noRunTopic || "";
        node.overcurrentTopic = config.overcurrentTopic || "";
        node.resetTopic = config.resetTopic || "";
        node.runtimeTopic = config.runtimeTopic || "";
        node.runtimeFilePath = config.runtimeFilePath || ""; // Optional - if empty, use default
        node.enableSystemLog = config.enableSystemLog === true; // default false

        // Timing with validation
        node.errorDelaySec = Number(config.errorDelaySec ?? 1.0);
        node.startDelaySec = Number(config.startDelaySec ?? 2.0);
        node.retryIntervalSec = Number(config.retryIntervalSec ?? 5.0); // Interval for retrying commands when feedback doesn't match

        // Validate ranges
        if (node.errorDelaySec < 0.1 || node.errorDelaySec > 60) {
            node.warn(`errorDelaySec out of range (0.1-60s), using default 1.0s`);
            node.errorDelaySec = 1.0;
        }
        if (node.startDelaySec < 0.1 || node.startDelaySec > 300) {
            node.warn(`startDelaySec out of range (0.1-300s), using default 2.0s`);
            node.startDelaySec = 2.0;
        }
        if (node.retryIntervalSec < 0.5 || node.retryIntervalSec > 60) {
            node.warn(`retryIntervalSec out of range (0.5-60s), using default 5.0s`);
            node.retryIntervalSec = 5.0;
        }

        // Validate errorDelay >= startDelay
        if (node.errorDelaySec < node.startDelaySec) {
            node.warn(`errorDelaySec (${node.errorDelaySec}s) must be >= startDelaySec (${node.startDelaySec}s), adjusting to ${node.startDelaySec}s`);
            node.errorDelaySec = node.startDelaySec;
        }

        // ---- STATE
        let commandState = 0; // 0=stop, 1=start (from controller or manual input)
        let commandStartTime = null; // timestamp when start command was issued

        // Discrete feedback mode
        let contactorFeedback = null; // feedback signal (0/1)
        let relayState = null; // relay command state (0/1)

        // Current feedback mode
        let currentActual = null; // actual current (A)
        let currentLoLimit = node.currentLoLimit; // lower limit for "running" detection (from config)
        let currentHiLimit = null; // upper limit for overcurrent protection (from iolayer)

        // Error states
        let fuseOFF = 0; // 0=OK, 1=fuse tripped
        let feedbackMismatch = false; // feedback ≠ relay (digital mode)
        let noRun = false; // no feedback/current after start delay over
        let overcurrent = false; // LATCHED - current > hiLimit after start delay over

        // Timers
        let errorCheckTimer = null; // for feedback mismatch (digital mode)
        let startCheckTimer = null; // for no-run detection
        let runtimeTimer = null; // for runtime accumulation
        let retryTimer = null; // for retrying commands when feedback doesn't match

        // Runtime tracking
        let runtimeHours = 0; // accumulated runtime in hours
        let runtimeStartTime = null; // timestamp when pump started
        let isRunning = false; // actual running state
        let lastRunningState = false; // for state change logging

        // Runtime persistence file path
        // If configured, use it; otherwise default to {userDir}/pump-runtime/{node.id}.json
        // If configured path does not end with .json, treat it as a directory and use {path}/{node.id}.json
        function resolveRuntimeFilePath() {
            const raw = node.runtimeFilePath && node.runtimeFilePath.trim() ? node.runtimeFilePath.trim() : null;
            if (!raw) {
                return path.join(RED.settings.userDir || ".", "pump-runtime", `${node.id}.json`);
            }
            if (raw.toLowerCase().endsWith(".json")) {
                return raw;
            }
            return path.join(raw, `${node.id}.json`);
        }
        const runtimeFilePath = resolveRuntimeFilePath();

        // Load runtime from file on startup
        function loadRuntime() {
            try {
                if (fs.existsSync(runtimeFilePath)) {
                    const data = fs.readFileSync(runtimeFilePath, "utf8");
                    const runtimeData = JSON.parse(data);
                    if (typeof runtimeData.runtimeHours === "number" && runtimeData.runtimeHours >= 0) {
                        runtimeHours = runtimeData.runtimeHours;
                        if (node.enableSystemLog) {
                            node.debug(`Loaded runtime from file: ${runtimeHours.toFixed(2)}h`);
                        }
                    }
                }
            } catch (err) {
                node.warn(`Failed to load runtime from file: ${err.message}`);
                if (node.enableSystemLog) {
                    systemLog("warn", `Runtime file path: ${runtimeFilePath}`);
                }
            }
        }

        // Save runtime to file
        function saveRuntime() {
            const fileToUse = resolveRuntimeFilePath();
            try {
                // Ensure directory exists
                const dir = path.dirname(fileToUse);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                const runtimeData = {
                    runtimeHours: runtimeHours,
                    lastUpdated: new Date().toISOString()
                };

                fs.writeFileSync(fileToUse, JSON.stringify(runtimeData, null, 2), "utf8");
                if (node.enableSystemLog) {
                    node.debug(`Saved runtime to file: ${fileToUse} (${runtimeHours.toFixed(2)}h)`);
                }
            } catch (err) {
                node.warn(`Failed to save runtime to file: ${err.message}`);
                if (node.enableSystemLog) {
                    systemLog("warn", `Runtime file path: ${fileToUse}`);
                }
            }
        }

        // Load runtime on startup
        loadRuntime();

        if (node.enableSystemLog) {
            node.log(
                `Started: cmdIn=${node.pumpCmdInputTopic || "-"}, cmdOut=${node.pumpCmdTopic}, feedback=${node.pumpFeedbackTopic || "-"}`
            );
        }

        // Helper function for system logging
        function systemLog(level, message) {
            if (!node.enableSystemLog) {
                return;
            }
            if (level === "error") {
                node.error(message);
            } else if (level === "warn") {
                node.warn(message);
            } else {
                node.log(message);
            }
        }

        function updateStatus() {
            let parts = [];
            let warnings = [];

            // Safety: Clear noRun if command is off (shouldn't happen, but safeguard)
            if (commandState === 0 && noRun) {
                noRun = false;
            }

            // Pump state
            if (isRunning) {
                parts.push("ON");
            } else if (commandState === 0 && !overcurrent && !feedbackMismatch && fuseOFF !== 1) {
                // Pump is off and no errors - show IDLE
                parts.push("IDLE");
            } else {
                parts.push("OFF");
            }

            // Show current if in current mode
            if (node.feedbackType === "current" && currentActual !== null) {
                parts.push(`${currentActual.toFixed(1)}A`);
            }

            // Runtime
            if (runtimeHours > 0) {
                parts.push(`${runtimeHours.toFixed(1)}h`);
            }

            // Warnings/errors (only show if active and relevant)
            if (overcurrent) warnings.push("OC!");
            // NORUN only when commanded to run but no feedback
            if (noRun && commandState === 1) warnings.push("NORUN!");
            if (feedbackMismatch) warnings.push("FB!");
            if (fuseOFF === 1) warnings.push("FUSE!");

            const statusText = parts.concat(warnings).join(" ");

            // Determine color: idle=green, running=yellow, any error=red
            // During switch-on: yellow until errorDelaySec has passed (even if no feedback yet); after errorDelaySec with no feedback → red
            let fill = "grey";
            let shape = "dot";

            const now = Date.now();
            const cmdOnNoFeedback = commandState === 1 && !isRunning;
            const errorDelayElapsed = commandStartTime !== null && now - commandStartTime >= node.errorDelaySec * 1000;
            const noFeedbackError = cmdOnNoFeedback && errorDelayElapsed; // red only after error delay with still no feedback

            const hasError = overcurrent || fuseOFF === 1 || feedbackMismatch || noFeedbackError;
            if (hasError) {
                fill = "red"; // any error (or no feedback after error delay)
            } else if (isRunning || cmdOnNoFeedback) {
                fill = "yellow"; // running or starting (within error-delay grace, even if no feedback yet)
                if (cmdOnNoFeedback) shape = "ring";
            } else {
                fill = "green"; // idle (stopped, no error)
            }

            node.status({ fill, shape, text: statusText });
        }

        // Initialize: ensure noRun is cleared if pump is not commanded to run
        if (commandState === 0 && noRun) {
            noRun = false;
        }

        updateStatus();

        // ---- RUNTIME TRACKING
        function startRuntimeTracking() {
            if (!isRunning) {
                isRunning = true;
                runtimeStartTime = Date.now();

                // Update runtime every 60 seconds
                if (!runtimeTimer) {
                    runtimeTimer = setInterval(() => {
                        if (isRunning && runtimeStartTime) {
                            const elapsedMs = Date.now() - runtimeStartTime;
                            runtimeHours += elapsedMs / (1000 * 60 * 60);
                            runtimeStartTime = Date.now();
                            publishRuntime();
                            saveRuntime(); // Periodic save every 60s when running
                            updateStatus();
                        }
                    }, 60000);
                }
            }
        }

        function stopRuntimeTracking() {
            if (isRunning) {
                // Add final elapsed time
                if (runtimeStartTime) {
                    const elapsedMs = Date.now() - runtimeStartTime;
                    runtimeHours += elapsedMs / (1000 * 60 * 60);
                    runtimeStartTime = null;
                    publishRuntime();
                    // Save to file when pump stops
                    saveRuntime();
                }
                isRunning = false;
            }
        }

        function publishRuntime() {
            if (node.runtimeTopic) {
                node.send({
                    topic: node.runtimeTopic,
                    payload: parseFloat(runtimeHours.toFixed(2))
                });
            }
        }

        publishRuntime();

        // ---- ERROR DETECTION
        function scheduleErrorCheck() {
            if (errorCheckTimer) {
                clearTimeout(errorCheckTimer);
                errorCheckTimer = null;
            }

            errorCheckTimer = setTimeout(() => {
                errorCheckTimer = null;
                checkFeedbackMismatch();
            }, node.errorDelaySec * 1000);
        }

        function scheduleStartCheck() {
            if (startCheckTimer) {
                clearTimeout(startCheckTimer);
                startCheckTimer = null;
            }

            startCheckTimer = setTimeout(() => {
                startCheckTimer = null;
                checkNoRun();
            }, node.startDelaySec * 1000);
        }

        function checkFeedbackMismatch() {
            // Only for discrete mode
            if (node.feedbackType !== "discrete") return;

            if (contactorFeedback !== null && relayState !== null) {
                const mismatch = contactorFeedback !== relayState;

                if (mismatch && !feedbackMismatch) {
                    feedbackMismatch = true;
                    const msg = `Feedback mismatch: feedback=${contactorFeedback}, relay=${relayState}`;
                    node.warn(msg);
                } else if (!mismatch && feedbackMismatch) {
                    feedbackMismatch = false;
                    const msg = `Feedback mismatch cleared`;
                    node.log(msg);
                }
            }
            publishErrors();
            updateStatus();
        }

        function checkNoRun() {
            // Check if pump should be running but no feedback/current detected
            if (commandState === 1) {
                let shouldBeRunning = false;

                if (node.feedbackType === "discrete") {
                    shouldBeRunning = contactorFeedback === 1;
                } else if (node.feedbackType === "current") {
                    shouldBeRunning = currentActual !== null && currentLoLimit !== null && currentActual > currentLoLimit;
                }

                if (!shouldBeRunning && !noRun) {
                    noRun = true;
                    const msg = `No run detected: command=1 but no feedback/current after ${node.startDelaySec}s`;
                    node.warn(msg);
                    publishErrors();
                } else if (shouldBeRunning && noRun) {
                    noRun = false;
                    const msg = `No run cleared: feedback/current detected`;
                    node.log(msg);
                    publishErrors();
                }
            }

            // Always clear no-run if command is off (not just when noRun was true)
            if (commandState === 0 && noRun) {
                noRun = false;
                publishErrors();
            }

            updateStatus();
        }

        function checkOvercurrent() {
            // Only for current mode
            if (node.feedbackType !== "current") return;

            if (currentActual !== null && currentHiLimit !== null) {
                // Ignore overcurrent during startup grace period (inrush current)
                if (commandState === 1 && commandStartTime !== null) {
                    const elapsedMs = Date.now() - commandStartTime;
                    const graceMs = node.startDelaySec * 1000;

                    if (elapsedMs < graceMs) {
                        // Still in grace period - ignore overcurrent (inrush)
                        return;
                    }
                }

                // Outside grace period - check for overcurrent
                if (currentActual > currentHiLimit && !overcurrent) {
                    overcurrent = true; // LATCHED
                    const msg = `OVERCURRENT LATCHED: ${currentActual.toFixed(1)}A > ${currentHiLimit.toFixed(1)}A`;
                    node.error(msg);
                    publishErrors();
                    updateStatus();
                }
            }
        }

        function checkRunningState() {
            let newRunningState = false;

            if (node.feedbackType === "discrete") {
                newRunningState = contactorFeedback === 1;
            } else if (node.feedbackType === "current") {
                newRunningState = currentActual !== null && currentLoLimit !== null && currentActual > currentLoLimit;
            }

            // Check if command matches feedback and retry if not
            const commandMatchesFeedback = (commandState === 1 && newRunningState) || (commandState === 0 && !newRunningState);

            if (!commandMatchesFeedback && contactorFeedback !== null) {
                // Command doesn't match feedback - schedule retry after interval (don't retry immediately)
                const now = Date.now();
                const startDelayElapsed = commandStartTime === null || now - commandStartTime >= node.startDelaySec * 1000;

                if (commandState === 0 && newRunningState) {
                    // Commanded OFF but still running - schedule retry after interval
                    if (!retryTimer) {
                        node.warn(`Command mismatch: commanded OFF but feedback shows ON - will retry after ${node.retryIntervalSec}s`);
                        // Wait for retry interval before retrying
                        retryTimer = setTimeout(() => {
                            retryTimer = null;
                            // Check if still mismatched, then retry
                            const stillRunning =
                                (node.feedbackType === "discrete" && contactorFeedback === 1) ||
                                (node.feedbackType === "current" && currentActual !== null && currentLoLimit !== null && currentActual > currentLoLimit);
                            if (commandState === 0 && stillRunning) {
                                node.warn(`Still not stopped - retrying stop command`);
                                sendPumpCmd(0);
                                // Schedule another retry check
                                retryTimer = setTimeout(() => {
                                    retryTimer = null;
                                    checkRunningState(); // Re-check and retry if needed
                                }, node.retryIntervalSec * 1000);
                            } else {
                                checkRunningState(); // Re-check state
                            }
                        }, node.retryIntervalSec * 1000);
                    }
                } else if (commandState === 1 && !newRunningState && startDelayElapsed) {
                    // Commanded ON but not running after start delay - schedule retry after interval
                    if (!retryTimer) {
                        node.warn(`Command mismatch: commanded ON but feedback shows OFF after start delay - will retry after ${node.retryIntervalSec}s`);
                        // Wait for retry interval before first retry
                        retryTimer = setTimeout(() => {
                            // After first retry, continue retrying periodically
                            if (commandState === 1) {
                                const isRunning =
                                    (node.feedbackType === "discrete" && contactorFeedback === 1) ||
                                    (node.feedbackType === "current" && currentActual !== null && currentLoLimit !== null && currentActual > currentLoLimit);
                                if (!isRunning) {
                                    node.warn(`Still not running - retrying start command`);
                                    sendPumpCmd(1);
                                    // Continue retrying periodically
                                    retryTimer = setInterval(() => {
                                        if (commandState === 1) {
                                            const isRunning =
                                                (node.feedbackType === "discrete" && contactorFeedback === 1) ||
                                                (node.feedbackType === "current" && currentActual !== null && currentLoLimit !== null && currentActual > currentLoLimit);
                                            if (!isRunning) {
                                                node.warn(`Still not running - retrying start command`);
                                                sendPumpCmd(1);
                                            } else {
                                                // Feedback matches now, clear retry timer
                                                clearInterval(retryTimer);
                                                retryTimer = null;
                                            }
                                        } else {
                                            // Command changed, clear retry timer
                                            clearInterval(retryTimer);
                                            retryTimer = null;
                                        }
                                    }, node.retryIntervalSec * 1000);
                                } else {
                                    // Feedback matches now, clear retry timer
                                    retryTimer = null;
                                }
                            } else {
                                retryTimer = null;
                            }
                        }, node.retryIntervalSec * 1000);
                    }
                }
            } else if (commandMatchesFeedback && retryTimer) {
                // Command now matches feedback - clear retry timer
                if (typeof retryTimer === "number") {
                    clearTimeout(retryTimer);
                } else {
                    clearInterval(retryTimer);
                }
                retryTimer = null;
                node.log(`Command now matches feedback - retry stopped`);
            }

            // Check and clear noRun if feedback is now present
            // This ensures noRun is cleared immediately when feedback arrives, not just after timer
            if (commandState === 1 && noRun && newRunningState) {
                noRun = false;
                const msg = `No run cleared: feedback/current detected`;
                node.log(msg);
                publishErrors();
            }

            // State change logging
            if (newRunningState !== lastRunningState) {
                if (newRunningState) {
                    node.log(`Pump STARTED (${node.feedbackType} mode)`);
                    startRuntimeTracking();
                } else {
                    node.log(`Pump STOPPED (${node.feedbackType} mode)`);
                    stopRuntimeTracking();
                }
                lastRunningState = newRunningState;
            } else {
                // Update tracking state
                if (newRunningState) {
                    startRuntimeTracking();
                } else {
                    stopRuntimeTracking();
                }
            }

            updateStatus();
        }

        function publishErrors() {
            const combinedError = feedbackMismatch || noRun || overcurrent || fuseOFF === 1;

            if (node.pumpErrorTopic) {
                node.send({
                    topic: node.pumpErrorTopic,
                    payload: combinedError ? 1 : 0
                });
            }

            if (node.noRunTopic) {
                node.send({
                    topic: node.noRunTopic,
                    payload: noRun ? 1 : 0
                });
            }

            // Output overcurrent separately for level controller swap logic
            if (node.overcurrentTopic) {
                node.send({
                    topic: node.overcurrentTopic,
                    payload: overcurrent ? 1 : 0
                });
            }
        }

        function sendPumpCmd(value) {
            if (!node.pumpCmdTopic) {
                node.warn("Pump command topic not configured");
                return;
            }
            const msg = { topic: node.pumpCmdTopic, payload: value };
            node.send(msg);
            if (node.enableSystemLog) {
                node.debug(`Sending pump command: topic='${node.pumpCmdTopic}', payload=${value}`);
            }
        }

        function processCommand(newCmd) {
            if (newCmd !== commandState) {
                const oldCmd = commandState;
                commandState = newCmd;

                // Track start time for grace period
                if (commandState === 1) {
                    commandStartTime = Date.now();
                } else {
                    commandStartTime = null;
                }

                node.log(`Command changed: ${oldCmd} -> ${commandState} (${commandState === 1 ? "start" : "stop"})`);

                sendPumpCmd(commandState);

                // Schedule start check if commanding ON
                if (commandState === 1) {
                    // Clear noRun on new start command (active start attempt)
                    // NORUN will be set again if feedback doesn't arrive after start delay
                    if (noRun) {
                        noRun = false;
                        publishErrors();
                    }
                    scheduleStartCheck();
                } else {
                    // Clear no-run if commanding OFF
                    if (startCheckTimer) {
                        clearTimeout(startCheckTimer);
                        startCheckTimer = null;
                    }
                    if (noRun) {
                        noRun = false;
                        publishErrors();
                        updateStatus(); // Update status immediately to show IDLE
                    }
                }
            }
            checkRunningState();
        }

        function resetErrors() {
            if (overcurrent) {
                overcurrent = false;
                const msg = `Overcurrent error RESET`;
                node.log(msg);
                publishErrors();
                updateStatus();
            }
        }

        // ---- INPUT HANDLER
        node.on("input", (msg) => {
            const t = msg.topic || "";
            const p = msg.payload;

            // Reset command (special handling)
            if (t === node.resetTopic || msg.reset === true) {
                resetErrors();
                return;
            }

            // Command input (from level controller via configured topic)
            if (node.pumpCmdInputTopic && t === node.pumpCmdInputTopic) {
                const cmdValue = Array.isArray(p) ? p[0] : p;
                const newCmd = Number(cmdValue);

                // Validate command value (0 or 1)
                if (newCmd !== 0 && newCmd !== 1) {
                    node.warn(`Invalid command value: ${cmdValue}. Expected 0 (stop) or 1 (start).`);
                    return;
                }

                if (node.enableSystemLog) {
                    node.debug(`Received command via topic '${t}': ${newCmd}`);
                }
                processCommand(newCmd);
                return;
            }

            // Discrete feedback mode: [feedback, relay]
            if (t === node.pumpFeedbackTopic && node.feedbackType === "discrete") {
                let feedbackChanged = false;
                let relayChanged = false;

                if (Array.isArray(p) && p.length >= 2) {
                    const newFeedback = (p[0] == null ? null : (Number.isFinite(Number(p[0])) ? Number(p[0]) : null));
                    const newRelay = (p[1] == null ? null : (Number.isFinite(Number(p[1])) ? Number(p[1]) : null));
                    if (newFeedback === null && newRelay === null) return;

                    if (newFeedback !== null && contactorFeedback !== newFeedback) {
                        contactorFeedback = newFeedback;
                        feedbackChanged = true;
                    }
                    if (newRelay !== null && relayState !== newRelay) {
                        relayState = newRelay;
                        relayChanged = true;
                    }
                } else if (Array.isArray(p) && p.length === 1) {
                    const newFeedback = (p[0] == null ? null : (Number.isFinite(Number(p[0])) ? Number(p[0]) : null));
                    if (newFeedback === null) return;
                    if (contactorFeedback !== newFeedback) {
                        contactorFeedback = newFeedback;
                        feedbackChanged = true;
                    }
                } else {
                    const newFeedback = (p == null ? null : (Number.isFinite(Number(p)) ? Number(p) : null));
                    if (newFeedback === null) return;
                    if (contactorFeedback !== newFeedback) {
                        contactorFeedback = newFeedback;
                        feedbackChanged = true;
                    }
                }

                if (feedbackChanged || relayChanged) {
                    scheduleErrorCheck();
                }

                checkRunningState();
                return;
            }

            // Current feedback mode: [actual, hiLimit]
            if (t === node.pumpCurrentTopic && node.feedbackType === "current") {
                if (Array.isArray(p) && p.length >= 2) {
                    const act = (p[0] == null ? null : (Number.isFinite(Number(p[0])) ? Number(p[0]) : null));
                    const hi = (p[1] == null ? null : (Number.isFinite(Number(p[1])) ? Number(p[1]) : null));
                    if (act === null) return;
                    currentActual = act;
                    if (hi !== null) currentHiLimit = hi;
                    // loLimit comes from config: node.currentLoLimit
                } else if (Array.isArray(p) && p.length === 1) {
                    const act = (p[0] == null ? null : (Number.isFinite(Number(p[0])) ? Number(p[0]) : null));
                    if (act === null) return;
                    currentActual = act;
                } else {
                    const act = (p == null ? null : (Number.isFinite(Number(p)) ? Number(p) : null));
                    if (act === null) return;
                    currentActual = act;
                }

                checkOvercurrent();
                checkRunningState();
                return;
            }

            // Fuse OFF input
            if (t === node.fuseOFFTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const newFuseOFF = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                if (newFuseOFF === null) {
                    if (fuseOFF !== 1) {
                        fuseOFF = 1;
                        node.error("External fuse unknown - treat as TRIPPED");
                        publishErrors();
                        updateStatus();
                    }
                    return;
                }

                if (newFuseOFF !== fuseOFF) {
                    fuseOFF = newFuseOFF;
                    if (fuseOFF === 1) {
                        const msg = `External fuse TRIPPED`;
                        node.error(msg);
                    } else {
                        const msg = `External fuse OK`;
                        node.log(msg);
                    }
                    publishErrors();
                    updateStatus();
                }
                return;
            }

            // If we get here, the message topic doesn't match any configured input topic
            // Silently ignore it (e.g., LVW.* messages from read nodes that shouldn't be processed here)
            // Build list of all expected topics for this node
            const expectedTopics = [node.pumpCmdInputTopic, node.pumpFeedbackTopic, node.pumpCurrentTopic, node.fuseOFFTopic, node.resetTopic].filter(
                (topic) => topic && topic.length > 0
            );

            // If topic doesn't match any expected topic and it's not a direct command, silently ignore
            if (expectedTopics.length > 0 && !expectedTopics.includes(t) && t !== "cmd" && msg.cmd === undefined) {
                // Silently ignore - don't log, don't process
                return;
            }
        });

        node.on("close", () => {
            if (errorCheckTimer) {
                clearTimeout(errorCheckTimer);
                errorCheckTimer = null;
            }
            if (startCheckTimer) {
                clearTimeout(startCheckTimer);
                startCheckTimer = null;
            }
            if (runtimeTimer) {
                clearInterval(runtimeTimer);
                runtimeTimer = null;
            }
            if (retryTimer) {
                if (typeof retryTimer === "number") {
                    clearTimeout(retryTimer);
                } else {
                    clearInterval(retryTimer);
                }
                retryTimer = null;
            }

            // Save final runtime
            stopRuntimeTracking();
            saveRuntime(); // Ensure runtime is saved on node close

            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-pump", PumpNode);
};
