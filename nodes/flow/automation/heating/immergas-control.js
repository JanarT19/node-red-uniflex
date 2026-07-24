const ts = require("../../core/lib/timestamp.js");
/**
 * Immergas Vitrix Gas Boiler Control Node
 *
 * Controls Immergas boiler with keepalive heat request and selective setpoint writes + bug workaround
 *
 * Features:
 * - Reads desired setpoint from THFW.1 (°C)
 * - Reads actual setpoint from THFW.2 (°C) and writes HSETV.1 only when mismatch (THFW.1 != THFW.2)
 * - Sends keepalive HREQV.1 every configurable period (default 20s) when heating active (must be <=30s)
 * - Monitors boiler state via IMODW.2 (heating activity), IMODW.3 (DHW activity), IMODW.4 (flame)
 * - Workaround for stuck heating bug (temporary +1°C bump if all activity/flame off for >1 min)
 * - Status display: idle / DHW on / heating ON
 */

module.exports = function (RED) {
    "use strict";

    function ImmergasControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        node.setpointReadTopic = config.setpointReadTopic || "THFW.1";
        node.setpointActualTopic = config.setpointActualTopic || "THFW.2";
        node.setpointWriteTopic = config.setpointWriteTopic || "HSETV.1"; // Changed from THFW.2 to HSETV.1 (h! regtype)
        node.heatingRequestWriteTopic = config.heatingRequestWriteTopic || "HREQV.1"; // h! regtype
        node.heatingRequestValue = parseInt(config.heatingRequestValue) || 85; // Default 85
        node.dhwEnableTopic = config.dhwEnableTopic || "ISETW.1";
        node.heatingEnableTopic = config.heatingEnableTopic || "ISETW.2";
        node.heatingRequestTopic = config.heatingRequestTopic || "ISETW.4";
        node.pumpHeatingTopic = config.pumpHeatingTopic || "IMODW.2";
        node.pumpDhwTopic = config.pumpDhwTopic || "IMODW.3";
        node.flameTopic = config.flameTopic || "IMODW.4";

        node.forcedWritePeriod = parseInt(config.forcedWritePeriod) || 20; // seconds
        node.stuckTimeout = parseInt(config.stuckTimeout) || 60; // seconds
        node.recoveryRetryInterval = parseInt(config.recoveryRetryInterval) || 300; // seconds (5 min)

        // State variables
        node.setpointDesired = null; // from THFW.1, °C
        node.setpointActual = null; // from THFW.2, °C
        node.dhwEnable = null;
        node.heatingEnable = null;
        node.heatingRequest = null;
        node.pumpHeating = null;
        node.pumpDhw = null;
        node.flame = null;
        node.pumpHeatingTs = 0;
        node.pumpDhwTs = 0;
        node.flameTs = 0;

        node.lastKeepaliveWriteTime = 0;
        node.allOffSinceTime = null;
        node.lastRecoveryAttemptTime = 0;
        node.recoveryInProgress = false;
        node.recoveryStage = null; // 'bump-up', 'wait', 'restore'

        // Timers
        node.controlTimer = null;
        node.recoveryTimer = null;

        const SETPOINT_MISMATCH_EPS = 0.1; // °C, avoid jitter / rounding noise

        /**
         * Update node status display
         * IMODW.2 = pump in heating mode
         * IMODW.3 = pump in DHW mode
         * IMODW.4 = flame active
         */
        function updateStatus() {
            let status = "idle";
            let color = "grey";

            // Check pump in DHW mode (IMODW.3)
            if (node.pumpDhw === 1 || node.pumpDhw === true) {
                status = "DHW on";
                color = "blue";
            }

            // Check pump in heating mode (IMODW.2) - overrides DHW status
            if (node.pumpHeating === 1 || node.pumpHeating === true) {
                status = "heating ON";
                color = "green";
            }

            // Flame adds yellow highlight
            if (node.flame === 1 || node.flame === true) {
                color = "yellow";
            }

            // Recovery overrides color
            if (node.recoveryInProgress) {
                status += " (recovery)";
                color = "orange";
            }

            // Add setpoints if available
            if (node.setpointDesired !== null) {
                status += ` | sp: ${node.setpointDesired}°C`;
            }
            if (node.setpointActual !== null) {
                status += ` (act: ${node.setpointActual}°C)`;
            }

            node.status({
                fill: color,
                shape: "dot",
                text: status
            });
        }

        /**
         * Log event (always visible).
         * Do not prefix wall-clock time here: wrapNode already stamps warn/error,
         * and Node-RED already timestamps node.log lines.
         */
        function logEvent(message, isWarning = false) {
            if (isWarning) {
                node.warn(message);
            } else {
                node.log(message);
            }
        }

        /**
         * Log important state changes (always visible)
         */
        function logImportant(message) {
            node.warn(`Immergas: ${message}`);
        }

        /**
         * Determine if heating is active (enabled + request)
         */
        function isHeatingActive() {
            return (node.heatingEnable === 1 || node.heatingEnable === true) && (node.heatingRequest === 1 || node.heatingRequest === true);
        }

        /**
         * Determine if we should treat heating as active based on recent keepalives.
         * This covers cases where the read-side heatingRequest flag is stale/absent,
         * but we are still sending HREQV keepalives and heating is enabled.
         */
        function isKeepaliveActive() {
            const enabled = node.heatingEnable === 1 || node.heatingEnable === true;
            const sinceKeepalive = (Date.now() - (node.lastKeepaliveWriteTime || 0)) / 1000;
            return enabled && sinceKeepalive <= node.forcedWritePeriod * 2; // allow one missed tick
        }

        /**
         * Decide if setpoint write is needed (THFW.1 != THFW.2)
         */
        function isSetpointWriteNeeded(targetC) {
            if (targetC === null || targetC === undefined) return false;
            if (node.setpointActual === null || node.setpointActual === undefined) return true; // no feedback yet -> best effort
            const a = parseFloat(node.setpointActual);
            const t = parseFloat(targetC);
            if (Number.isNaN(a) || Number.isNaN(t)) return true;
            return Math.abs(t - a) >= SETPOINT_MISMATCH_EPS;
        }

        /**
         * Send keepalive (HREQV.1) always; optionally also send setpoint (HSETV.1)
         *
         * IMPORTANT Node-RED detail:
         * - node.send([msg1, msg2]) routes to multiple outputs (output 1 gets msg1, output 2 gets msg2).
         * - With outputs=1 that drops msg2.
         * - Correct single-output multi-message send is: node.send([[msg1, msg2]])
         */
        function sendHeatingWrites({ setpointC = null, includeSetpoint = false, isRecovery = false, reason = "periodic" }) {
            const msgs = [];

            msgs.push({
                topic: node.heatingRequestWriteTopic,
                payload: node.heatingRequestValue
            });

            if (includeSetpoint) {
                if (setpointC === null || setpointC === undefined || Number.isNaN(parseFloat(setpointC))) {
                    node.warn(`[immergas-control] Skipping setpoint write: invalid setpointC=${setpointC}`);
                } else {
                    msgs.push({
                        topic: node.setpointWriteTopic,
                        payload: setpointC
                    });
                }
            }

            if (msgs.length === 0) return;

            // Emit all messages on the SAME output
            node.debug(`[immergas-control] send ${msgs.map((m) => `${m.topic}=${m.payload}`).join(", ")} (${reason}${isRecovery ? ", recovery" : ""})`);
            node.send([msgs]);

            node.lastKeepaliveWriteTime = Date.now();

            if (isRecovery) {
                logImportant(`WRITE (${reason}, RECOVERY): ${msgs.map((m) => `${m.topic}=${m.payload}`).join(", ")}`);
            } else {
                logEvent(`WRITE (${reason}): ${msgs.map((m) => `${m.topic}=${m.payload}`).join(", ")}`);
            }
        }

        /**
         * Check if heating is stuck (bug workaround)
         */
        function checkStuckHeating() {
            const now = Date.now();

            // Only relevant while heating is actually supposed to be active
            const heatingActive = isHeatingActive();
            const keepaliveActive = isKeepaliveActive();

            if (!heatingActive && !keepaliveActive) {
                // No request and no recent keepalive -> do nothing
                if (node.allOffSinceTime !== null) {
                    logEvent("Stuck timer reset: heating not active (no request/keepalive)");
                }
                node.allOffSinceTime = null;
                return;
            }

            // Consider signals stale if not updated within 90s (or 2x forcedWritePeriod, whichever is larger)
            const staleWindowMs = Math.max(node.forcedWritePeriod * 2 * 1000, 90000);

            const pumpHeatingKnown = node.pumpHeating !== null && node.pumpHeating !== undefined;
            const pumpDhwKnown = node.pumpDhw !== null && node.pumpDhw !== undefined;
            const flameKnown = node.flame !== null && node.flame !== undefined;

            const pumpHeatingStale = pumpHeatingKnown && now - node.pumpHeatingTs > staleWindowMs;
            const pumpDhwStale = pumpDhwKnown && now - node.pumpDhwTs > staleWindowMs;
            const flameStale = flameKnown && now - node.flameTs > staleWindowMs;

            // Treat unknown or stale as OFF but log once
            const pumpHeatingOff = !pumpHeatingKnown || pumpHeatingStale || node.pumpHeating === 0 || node.pumpHeating === false;
            const pumpDhwOff = !pumpDhwKnown || pumpDhwStale || node.pumpDhw === 0 || node.pumpDhw === false;
            const flameOff = !flameKnown || flameStale || node.flame === 0 || node.flame === false;

            if (!pumpHeatingKnown || !pumpDhwKnown || !flameKnown || pumpHeatingStale || pumpDhwStale || flameStale) {
                logEvent(
                    `Stuck check: signals ${[
                        !pumpHeatingKnown ? "IMODW.2=unknown" : pumpHeatingStale ? "IMODW.2=stale" : "",
                        !pumpDhwKnown ? "IMODW.3=unknown" : pumpDhwStale ? "IMODW.3=stale" : "",
                        !flameKnown ? "IMODW.4=unknown" : flameStale ? "IMODW.4=stale" : ""
                    ]
                        .filter(Boolean)
                        .join(", ")} treated as OFF`
                );
            }

            // Check if all activity indicators are off (with stale/unknown treated as off)
            const allOff = pumpHeatingOff && pumpDhwOff && flameOff;

            if (allOff) {
                if (node.allOffSinceTime === null) {
                    node.allOffSinceTime = now;
                    logImportant("All boiler activity OFF despite heating request - starting stuck timer");
                } else {
                    const offDuration = (now - node.allOffSinceTime) / 1000; // seconds

                    // Check if we need to attempt recovery
                    if (offDuration >= node.stuckTimeout) {
                        const timeSinceLastRecovery = (now - node.lastRecoveryAttemptTime) / 1000;

                        if (!node.recoveryInProgress && timeSinceLastRecovery >= node.recoveryRetryInterval) {
                            attemptRecovery();
                        } else if (node.recoveryInProgress) {
                            logEvent(`Recovery already in progress (stage=${node.recoveryStage})`);
                        } else {
                            logEvent(`Recovery throttled: last attempt ${timeSinceLastRecovery.toFixed(0)}s ago (<${node.recoveryRetryInterval}s)`);
                        }
                    }
                }
            } else {
                // Activity detected, reset timer
                if (node.allOffSinceTime !== null) {
                    logImportant("Boiler activity RESUMED");
                }
                node.allOffSinceTime = null;
            }
        }

        /**
         * Attempt recovery from stuck heating
         */
        function attemptRecovery() {
            if (node.setpointDesired === null) {
                node.warn("Cannot attempt recovery: desired setpoint unknown");
                return;
            }

            node.recoveryInProgress = true;
            node.lastRecoveryAttemptTime = Date.now();
            node.recoveryStage = "bump-up";

            logImportant(`RECOVERY START: heating stuck for >${node.stuckTimeout}s, bumping setpoint +1°C (${node.setpointDesired}°C → ${node.setpointDesired + 1}°C)`);

            // Stage 1: Bump setpoint up by 1°C
            sendHeatingWrites({
                setpointC: node.setpointDesired + 1,
                includeSetpoint: true,
                isRecovery: true,
                reason: "recovery-bump"
            });
            updateStatus();

            // Stage 2: Wait 60 seconds
            node.recoveryTimer = setTimeout(() => {
                node.recoveryStage = "restore";
                logImportant(`RECOVERY: restoring original setpoint to ${node.setpointDesired}°C`);
                sendHeatingWrites({
                    setpointC: node.setpointDesired,
                    includeSetpoint: true,
                    isRecovery: true,
                    reason: "recovery-restore"
                });

                // Stage 3: Complete recovery
                node.recoveryTimer = setTimeout(() => {
                    node.recoveryInProgress = false;
                    node.recoveryStage = null;
                    logImportant("RECOVERY COMPLETE");
                    updateStatus();
                }, 5000); // 5 seconds after restore
            }, 60000); // 60 seconds
        }

        /**
         * Main control tick
         */
        function handleControlTick() {
            const now = Date.now();

            // Keepalive while heating should be active
            if (isHeatingActive()) {
                const timeSinceLastKeepalive = (now - node.lastKeepaliveWriteTime) / 1000;
                if (timeSinceLastKeepalive >= node.forcedWritePeriod) {
                    const desired = node.setpointDesired;
                    const needSetpoint = isSetpointWriteNeeded(desired);
                    sendHeatingWrites({
                        setpointC: desired,
                        includeSetpoint: needSetpoint,
                        isRecovery: false,
                        reason: needSetpoint ? "keepalive+mismatch" : "keepalive"
                    });
                }
            }

            // Check for stuck heating (only if not in recovery)
            if (!node.recoveryInProgress) {
                checkStuckHeating();
            }

            updateStatus();
        }

        /**
         * Process incoming message
         */
        node.on("input", function (msg) {
            const topic = msg.topic;
            const payload = msg.payload;

            // Update state based on topic
            if (topic === node.setpointReadTopic) {
                if (node.setpointDesired !== payload) {
                    const oldValue = node.setpointDesired !== null ? `${node.setpointDesired}°C` : "unknown";
                    node.setpointDesired = payload;
                    const need = isSetpointWriteNeeded(node.setpointDesired);
                    const act = node.setpointActual !== null ? `${node.setpointActual}°C` : "unknown";
                    logImportant(`Setpoint DESIRED READ ${node.setpointReadTopic}: ${oldValue} → ${payload}°C (actual ${node.setpointActualTopic}: ${act}, writeNeeded=${need})`);

                    // If heating is active and mismatch exists, push setpoint immediately (with keepalive)
                    if (isHeatingActive() && need) {
                        sendHeatingWrites({
                            setpointC: node.setpointDesired,
                            includeSetpoint: true,
                            isRecovery: false,
                            reason: "desired-change+mismatch"
                        });
                    }
                } else {
                    node.setpointDesired = payload;
                }
            } else if (topic === node.setpointActualTopic) {
                node.setpointActual = payload;
            } else if (topic === node.dhwEnableTopic) {
                node.dhwEnable = payload;
            } else if (topic === node.heatingEnableTopic) {
                node.heatingEnable = payload;
            } else if (topic === node.heatingRequestTopic) {
                if (node.heatingRequest !== payload) {
                    node.heatingRequest = payload;
                    logImportant(`Heating request changed: ${payload ? "ON" : "OFF"}`);
                } else {
                    node.heatingRequest = payload;
                }
            } else if (topic === node.pumpHeatingTopic) {
                node.pumpHeating = payload;
                node.pumpHeatingTs = Date.now();
                logEvent(`IMODW.2 (pumpHeating) updated: ${payload}`);
            } else if (topic === node.pumpDhwTopic) {
                node.pumpDhw = payload;
                node.pumpDhwTs = Date.now();
                logEvent(`IMODW.3 (pumpDhw) updated: ${payload}`);
            } else if (topic === node.flameTopic) {
                node.flame = payload;
                node.flameTs = Date.now();
                logEvent(`IMODW.4 (flame) updated: ${payload}`);
            } else {
                // Ignore other topics silently
                return;
            }

            updateStatus();
        });

        /**
         * Start control loop
         */
        function startControlLoop() {
            if (node.controlTimer) {
                clearInterval(node.controlTimer);
            }

            // Run every second
            node.controlTimer = setInterval(handleControlTick, 1000);

            logImportant(`STARTED - Write period: ${node.forcedWritePeriod}s, Stuck timeout: ${node.stuckTimeout}s, Recovery retry: ${node.recoveryRetryInterval}s`);
            updateStatus();
        }

        /**
         * Stop control loop
         */
        function stopControlLoop() {
            if (node.controlTimer) {
                clearInterval(node.controlTimer);
                node.controlTimer = null;
            }

            if (node.recoveryTimer) {
                clearTimeout(node.recoveryTimer);
                node.recoveryTimer = null;
            }

            logImportant("STOPPED");
        }

        // Node lifecycle
        startControlLoop();

        node.on("close", function () {
            stopControlLoop();
        });
    }

    RED.nodes.registerType("uniflex-immergas-control", ImmergasControlNode);
};
