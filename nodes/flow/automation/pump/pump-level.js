const fs = require("fs");
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
        const maxCurrentLimitRaw = config.maxCurrentLimit;
        if (maxCurrentLimitRaw !== null && maxCurrentLimitRaw !== undefined && maxCurrentLimitRaw !== "") {
            const parsedLimit = Number(maxCurrentLimitRaw);
            node.maxCurrentLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
        } else {
            node.maxCurrentLimit = null;
        }
        node.numPumps = parseInt(config.numPumps ?? 2);
        node.enableRotation = config.enableRotation !== false; // default true
        node.swapDelaySec = Number(config.swapDelaySec ?? 30);
        node.startDelaySec = Number(config.startDelaySec ?? 2.0); // Delay before checking NORUN after pump start
        const maxPumpTimeRaw = config.maxPumpTimeSec;
        if (maxPumpTimeRaw === null || maxPumpTimeRaw === undefined || maxPumpTimeRaw === "") {
            node.maxPumpTimeSec = null;
        } else {
            const parsedMaxTime = Number(maxPumpTimeRaw);
            if (!Number.isFinite(parsedMaxTime) || parsedMaxTime <= 0) {
                node.maxPumpTimeSec = null;
            } else if (parsedMaxTime < 60) {
                node.warn(`maxPumpTimeSec ${parsedMaxTime} below minimum 60, max-time swap disabled`);
                node.maxPumpTimeSec = null;
            } else {
                node.maxPumpTimeSec = parsedMaxTime;
            }
        }
        node.maxTimeSwapEnabled = node.numPumps >= 2 && node.maxPumpTimeSec !== null;
        node.pumpSwapEnabled = node.numPumps >= 2;
        node.totalCurrentMeasured = config.totalCurrentMeasured !== false; // default true
        node.enableSystemLog = config.enableSystemLog === true; // default false
        node.enableRuntimeBalance = config.enableRuntimeBalance !== false; // default true
        node.runtimeBalanceThreshold = Number(config.runtimeBalanceThreshold ?? 0.1);
        if (node.runtimeBalanceThreshold < 0.05 || node.runtimeBalanceThreshold > 0.5) {
            node.warn(`runtimeBalanceThreshold out of range (0.05-0.5), using 0.1`);
            node.runtimeBalanceThreshold = 0.1;
        }
        // Level offset for starting 2nd pump (added to start level, null/undefined/empty = disabled)
        const levelStartPump2Val = config.levelStartPump2;
        node.levelStartPump2 = levelStartPump2Val !== null && levelStartPump2Val !== undefined && levelStartPump2Val !== "" ? Number(levelStartPump2Val) : null;

        // Parse pump runtime topics / file paths (one per pump, index-aligned)
        node.pumpRuntimeTopics = Array.isArray(config.pumpRuntimeTopics) ? config.pumpRuntimeTopics : [];
        node.pumpRuntimeFilePaths = Array.isArray(config.pumpRuntimeFilePaths) ? config.pumpRuntimeFilePaths : [];
        while (node.pumpRuntimeTopics.length < node.numPumps) {
            node.pumpRuntimeTopics.push("");
        }
        while (node.pumpRuntimeFilePaths.length < node.numPumps) {
            node.pumpRuntimeFilePaths.push("");
        }
        node.pumpRuntimeTopics = node.pumpRuntimeTopics.slice(0, node.numPumps).map((t) => (t || "").trim());
        node.pumpRuntimeFilePaths = node.pumpRuntimeFilePaths.slice(0, node.numPumps).map((t) => (t || "").trim());

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

        // Per-pump current sensor topics (index-aligned, used when totalCurrentMeasured is false)
        node.pumpCurrentTopics = Array.isArray(config.pumpCurrentTopics) ? config.pumpCurrentTopics : [];
        while (node.pumpCurrentTopics.length < node.numPumps) {
            node.pumpCurrentTopics.push("");
        }
        node.pumpCurrentTopics = node.pumpCurrentTopics.slice(0, node.numPumps).map((t) => (t || "").trim());

        // Validate configuration
        if (node.pumpCmdTopics.length !== node.numPumps) {
            node.warn(`Number of command topics (${node.pumpCmdTopics.length}) does not match numPumps (${node.numPumps})`);
        }

        // ---- STATE
        let levelActual = null; // Actual water level (m)
        let levelStart = null; // Start threshold (m)
        let levelStop = null; // Stop threshold (m)
        let LES = null; // Low float: 0=OK, non-zero=triggered (iolayer status may be 1 or 2)
        let LHS = null; // High float: 0=OK, non-zero=triggered
        let PWS = null; // Phase control: 0=OK, non-zero=fault

        function interlockActive(val, topicConfigured) {
            if (!topicConfigured) {
                return false;
            }
            if (val === null || val === undefined) {
                return true;
            }
            const n = Number(val);
            return Number.isFinite(n) && n !== 0;
        }

        let maxCurrentFromTopic = null; // Maximum allowed current per pump (A) from iolayer topic

        function getMaxCurrentLimit() {
            if (node.maxCurrentTopic && maxCurrentFromTopic !== null && Number.isFinite(maxCurrentFromTopic)) {
                return maxCurrentFromTopic;
            }
            return node.maxCurrentLimit;
        }

        function evaluateCurrentLimit() {
            const limit = getMaxCurrentLimit();
            if (limit === null || !Number.isFinite(limit)) {
                return { currentOK: true, ocDetail: null };
            }

            const activePumps = pumpCommands.filter((cmd) => cmd === 1).length;

            if (node.totalCurrentMeasured) {
                if (totalCurrent === null || activePumps === 0) {
                    return { currentOK: true, ocDetail: null };
                }
                const currentPerPump = totalCurrent / activePumps;
                if (currentPerPump >= limit) {
                    return {
                        currentOK: false,
                        ocDetail: `${currentPerPump.toFixed(1)}A/pump > ${limit.toFixed(1)}A`
                    };
                }
                return { currentOK: true, ocDetail: null };
            }

            for (let i = 0; i < node.numPumps; i++) {
                if (pumpCommands[i] !== 1) {
                    continue;
                }
                const cur = pumpCurrents[i];
                if (cur === null || !Number.isFinite(cur)) {
                    continue;
                }
                if (cur >= limit) {
                    return {
                        currentOK: false,
                        ocDetail: `P${i + 1} ${cur.toFixed(1)}A > ${limit.toFixed(1)}A`
                    };
                }
            }
            return { currentOK: true, ocDetail: null };
        }
        let totalCurrent = null; // Total current (A) - only used if totalCurrentMeasured is true
        let pumpCurrents = Array(node.numPumps).fill(null); // Per-pump current (A) when totalCurrentMeasured is false

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

        // Pump states
        let pumpCommands = Array(node.numPumps).fill(0); // 0=stop, 1=start
        let pumpErrors = Array(node.numPumps).fill(0); // 0=OK, 1=fuse OFF/problem (pump unusable)
        let pumpNoRun = Array(node.numPumps).fill(0); // 0=OK, 1=NORUN error
        let pumpOvercurrent = Array(node.numPumps).fill(0); // 0=OK, 1=overcurrent error
        let pumpStartTime = Array(node.numPumps).fill(0); // timestamp of last start (for start delay)
        let pumpNoRunStartTime = Array(node.numPumps).fill(0); // timestamp when NORUN was first detected
        let pumpSwapTimers = Array(node.numPumps).fill(null); // timers for swap on error
        let pumpMaxTimeTimers = Array(node.numPumps).fill(null); // timers for max runtime swap
        let pumpReplacementTimer = null; // delay before starting replacement pump after swap
        let rotationIndex = 0; // for pump rotation
        let rotationSeqIndex = 0; // index in runtime-balance sequence
        let pumpRuntimeHours = Array(node.numPumps).fill(null); // hours from topic or file
        let lastRuntimeBalanceSeqKey = null; // log sequence changes once

        function readRuntimeFile(filePath) {
            const fp = (filePath || "").trim();
            if (!fp) {
                return null;
            }
            try {
                if (!fs.existsSync(fp)) {
                    return null;
                }
                const data = JSON.parse(fs.readFileSync(fp, "utf8"));
                if (typeof data.runtimeHours === "number" && data.runtimeHours >= 0) {
                    return data.runtimeHours;
                }
            } catch (err) {
                if (node.enableSystemLog) {
                    node.debug(`Failed to read runtime file '${fp}': ${err.message}`);
                }
            }
            return null;
        }

        function refreshRuntimeFromFiles() {
            for (let i = 0; i < node.numPumps; i++) {
                const fp = node.pumpRuntimeFilePaths[i];
                if (!fp) {
                    continue;
                }
                const hours = readRuntimeFile(fp);
                if (hours !== null) {
                    pumpRuntimeHours[i] = hours;
                }
            }
        }

        function pumpHasRuntimeSource(pumpIdx) {
            const topic = node.pumpRuntimeTopics[pumpIdx] || "";
            const file = node.pumpRuntimeFilePaths[pumpIdx] || "";
            return topic.length > 0 || file.length > 0;
        }

        function runtimeBalanceActive() {
            if (!node.enableRotation || !node.enableRuntimeBalance || node.numPumps < 2) {
                return false;
            }
            refreshRuntimeFromFiles();
            for (let i = 0; i < node.numPumps; i++) {
                if (!pumpHasRuntimeSource(i)) {
                    return false;
                }
                if (pumpRuntimeHours[i] === null) {
                    return false;
                }
            }
            return true;
        }

        // Build wear-balance start sequence. For 2 pumps: overworked once, other twice (1-2-2-1...).
        function buildRuntimeBalanceSequence() {
            if (!runtimeBalanceActive()) {
                return null;
            }

            const hours = pumpRuntimeHours.map((h) => h ?? 0);
            let minH = Math.min(...hours);
            let maxH = Math.max(...hours);
            if (maxH <= 0) {
                return null;
            }
            if (minH <= 0) {
                minH = maxH * 0.01;
            }

            const ratio = maxH / minH;
            if (ratio <= 1 + node.runtimeBalanceThreshold) {
                return null;
            }

            let maxIdx = 0;
            for (let i = 1; i < hours.length; i++) {
                if (hours[i] > hours[maxIdx]) {
                    maxIdx = i;
                }
            }

            if (node.numPumps === 2) {
                const other = 1 - maxIdx;
                return [maxIdx, other, other];
            }

            // 3+ pumps: least-used first, overworked pump once per round
            const order = hours
                .map((h, i) => ({ i, h }))
                .sort((a, b) => a.h - b.h)
                .map((x) => x.i);
            const seq = order.filter((i) => i !== maxIdx);
            seq.push(maxIdx);
            return seq;
        }

        function buildPumpStartTryOrder() {
            refreshRuntimeFromFiles();
            const seq = buildRuntimeBalanceSequence();
            const order = [];

            if (seq && seq.length > 0) {
                for (let i = 0; i < seq.length; i++) {
                    const idx = seq[(rotationSeqIndex + i) % seq.length];
                    if (!order.includes(idx)) {
                        order.push(idx);
                    }
                }
                for (let i = 0; i < node.numPumps; i++) {
                    if (!order.includes(i)) {
                        order.push(i);
                    }
                }

                const seqKey = seq.map((i) => i + 1).join("-");
                if (node.enableSystemLog && lastRuntimeBalanceSeqKey !== seqKey) {
                    lastRuntimeBalanceSeqKey = seqKey;
                    const hoursStr = pumpRuntimeHours.map((h, i) => `P${i + 1}=${(h ?? 0).toFixed(1)}h`).join(" ");
                    node.log(`Runtime balance active (${hoursStr}), rotation pattern ${seqKey}`);
                }

                return { order, seq };
            }

            lastRuntimeBalanceSeqKey = null;
            if (node.enableRotation) {
                for (let i = 0; i < node.numPumps; i++) {
                    order.push((rotationIndex + i) % node.numPumps);
                }
            } else {
                for (let i = 0; i < node.numPumps; i++) {
                    order.push(i);
                }
            }
            return { order, seq: null };
        }

        function advanceRotationAfterStart(pumpIdx, seq) {
            if (seq && seq.length > 0) {
                rotationSeqIndex = (rotationSeqIndex + 1) % seq.length;
                return;
            }
            if (node.enableRotation) {
                rotationIndex = (pumpIdx + 1) % node.numPumps;
            }
        }

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

            // Current display
            if (node.totalCurrentMeasured && totalCurrent !== null && node.totalCurrentTopic) {
                const maxLimit = getMaxCurrentLimit();
                if (activePumps > 0 && maxLimit !== null) {
                    const currentPerPump = totalCurrent / activePumps;
                    parts.push(`${totalCurrent.toFixed(1)}A (${currentPerPump.toFixed(1)}A/pump)`);
                } else {
                    parts.push(`${totalCurrent.toFixed(1)}A`);
                }
            } else if (!node.totalCurrentMeasured) {
                const curParts = [];
                for (let i = 0; i < node.numPumps; i++) {
                    if (pumpCurrents[i] !== null && Number.isFinite(pumpCurrents[i])) {
                        curParts.push(`P${i + 1}=${pumpCurrents[i].toFixed(1)}A`);
                    }
                }
                if (curParts.length > 0) {
                    parts.push(curParts.join(" "));
                }
            }

            // Warnings only (show only if not 0)
            if (interlockActive(LES, !!node.lowFloatTopic)) warnings.push("LES!");
            if (interlockActive(LHS, !!node.highFloatTopic)) warnings.push("LHS!");
            if (interlockActive(PWS, !!node.phaseCtrlTopic)) warnings.push("PWS!");

            const currentLimit = evaluateCurrentLimit();
            if (!currentLimit.currentOK && currentLimit.ocDetail) {
                warnings.push(`OC! (${currentLimit.ocDetail})`);
            }

            // Pump fuse OFF states
            const errorPumps = pumpErrors.map((err, idx) => (err === 1 ? idx + 1 : null)).filter((idx) => idx !== null);
            if (errorPumps.length > 0) {
                warnings.push(`P${errorPumps.join(",")}FUSE`);
            }

            const statusText = parts.length > 0 ? parts.concat(warnings).join(" ") : "Waiting for level...";

            // Determine color
            let fill = "grey";
            if (interlockActive(LES, !!node.lowFloatTopic) || interlockActive(PWS, !!node.phaseCtrlTopic)) {
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

        if (node.enableSystemLog) {
            node.log(
                `Started: numPumps=${node.numPumps}, actual=${node.levelActualTopic}, start=${node.levelStartTopic}, stop=${node.levelStopTopic}`
            );
        }

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
            }

            // Safety checks
            const lowFloatOK = !interlockActive(LES, !!node.lowFloatTopic);
            const phaseOK = !interlockActive(PWS, !!node.phaseCtrlTopic);

            const currentLimit = evaluateCurrentLimit();
            const currentOK = currentLimit.currentOK;

            // Check if any pump should stop
            const shouldStopAll = !lowFloatOK || !phaseOK || !currentOK;

            if (shouldStopAll) {
                // Emergency stop all pumps
                let reason = [];
                if (!lowFloatOK) reason.push("LES");
                if (!phaseOK) reason.push("PWS");
                if (!currentOK && currentLimit.ocDetail) {
                    reason.push(`OC(${currentLimit.ocDetail})`);
                }

                for (let i = 0; i < node.numPumps; i++) {
                    if (pumpCommands[i] === 1) {
                        const msg = `EMERGENCY STOP pump ${i + 1}: ${reason.join(", ")}`;
                        node.warn(msg);
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
                    startPump(pumpIdx);
                } else {
                    // Log why no pump can start (only if system logging enabled to avoid spam)
                    if (node.enableSystemLog) {
                        const msg = `Cannot start any pump: all have fuse OFF or already running`;
                        node.warn(msg);
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
                        startPump(pumpIdx);
                    } else {
                        if (node.enableSystemLog) {
                            const msg = `Cannot start 2nd pump: all have fuse OFF or already running`;
                            node.warn(msg);
                        }
                    }
                } else {
                    // Don't log - threshold not met is normal, only log when it changes
                }
            } else if (activePumps > 0 && actual <= start) {
                // Normal hysteresis: pump stays on until level drops below stop threshold
                const bandState = `band_${activePumps}_${actual.toFixed(2)}_${start.toFixed(2)}`;
                if (!node.lastWarningState || node.lastWarningState !== bandState) {
                    node.lastWarningState = bandState;
                    if (node.enableSystemLog) {
                        systemLog("info", `Pumps running in start/stop band: level ${actual} <= start ${start}, stop at ${levelStop}`);
                    }
                }
            } else {
                // Clear warning state when condition no longer applies
                node.lastWarningState = null;
            }

            updateStatus();
            checkPumpSwapErrors(); // Check for swap conditions after control logic
        }

        function selectPumpToStart(excludePumpIdx = -1) {
            const { order, seq } = buildPumpStartTryOrder();

            for (const pumpIdx of order) {
                if (pumpIdx < 0 || pumpIdx >= node.numPumps) {
                    continue;
                }
                if (excludePumpIdx >= 0 && pumpIdx === excludePumpIdx) {
                    continue;
                }

                const hasFuseOFF = pumpErrors[pumpIdx] === 1;
                const isNotRunning = pumpCommands[pumpIdx] === 0;

                if (node.enableSystemLog && (hasFuseOFF || !isNotRunning)) {
                    const reasons = [];
                    if (hasFuseOFF) reasons.push("fuse OFF");
                    if (!isNotRunning) reasons.push("already running");
                    node.debug(`Pump ${pumpIdx + 1} unavailable: ${reasons.join(", ")}`);
                }

                if (!hasFuseOFF && isNotRunning) {
                    advanceRotationAfterStart(pumpIdx, seq);
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

        function scheduleReplacementPump(stoppedPumpIdx, reason) {
            if (!node.pumpSwapEnabled) {
                return;
            }

            if (pumpReplacementTimer) {
                clearTimeout(pumpReplacementTimer);
                pumpReplacementTimer = null;
            }

            const delayMs = node.startDelaySec * 1000;
            if (node.enableSystemLog) {
                node.log(`Replacement pump scheduled in ${node.startDelaySec}s (${reason})`);
            }

            pumpReplacementTimer = setTimeout(() => {
                pumpReplacementTimer = null;
                const newPumpIdx = selectPumpToStart(stoppedPumpIdx);
                if (newPumpIdx !== -1) {
                    const msg = `Starting replacement pump ${newPumpIdx + 1} (${reason})`;
                    node.log(msg);
                    startPump(newPumpIdx);
                } else {
                    node.warn(`Cannot start replacement pump (${reason}): no available pumps`);
                }
            }, delayMs);
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

            // Max runtime swap: only with 2+ pumps and configured maxPumpTimeSec
            if (node.maxTimeSwapEnabled) {
                pumpMaxTimeTimers[pumpIdx] = setTimeout(() => {
                    pumpMaxTimeTimers[pumpIdx] = null;

                    if (pumpCommands[pumpIdx] === 1) {
                        const msg = `Pump ${pumpIdx + 1} max runtime (${node.maxPumpTimeSec}s) reached - swapping pump`;
                        node.log(msg);
                        stopPump(pumpIdx);
                        scheduleReplacementPump(pumpIdx, "max time swap");
                    }
                }, node.maxPumpTimeSec * 1000);
            }

            sendPumpCommand(pumpIdx, 1);
        }

        function checkPumpSwapErrors() {
            if (!node.pumpSwapEnabled) {
                return;
            }

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
                        pumpSwapTimers[i] = setTimeout(() => {
                            pumpSwapTimers[i] = null;

                            // Check if error still exists and pump is still running
                            if (pumpCommands[i] === 1 && (pumpNoRun[i] === 1 || pumpOvercurrent[i] === 1)) {
                                node.error(`Pump ${i + 1} swap: error persists, swapping pump`);

                                stopPump(i);
                                scheduleReplacementPump(i, "NORUN/overcurrent swap");
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

            const outputs = Array(node.numPumps).fill(null);
            outputs[pumpIdx] = msg;
            node.send(outputs);
            const cmdStr = value === 1 ? "START" : "STOP";
            const logMsg = `Pump ${pumpIdx + 1} command -> ${cmdStr} (topic: ${node.pumpCmdTopics[pumpIdx]}, payload: ${value})`;
            if (node.enableSystemLog) {
                node.log(logMsg);
            }
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
                const newLES = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                if (newLES === null) {
                    if (LES !== null) {
                        node.error("LOW FLOAT unknown - emergency stop all pumps");
                    }
                    LES = null;
                    checkPumpControl();
                    return;
                }

                if (newLES !== LES) {
                    LES = newLES;
                    if (interlockActive(LES, true)) {
                        const msg = `LOW FLOAT TRIGGERED - emergency stop all pumps`;
                        node.error(msg);
                    } else {
                        const msg = `Low float cleared`;
                        node.log(msg);
                    }
                }
                checkPumpControl();
                return;
            }

            // High float switch (DI)
            if (t === node.highFloatTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const newLHS = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                if (newLHS === null) {
                    LHS = null;
                    checkPumpControl();
                    return;
                }
                LHS = newLHS;
                checkPumpControl();
                return;
            }

            // Phase control (DI)
            if (t === node.phaseCtrlTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const newPWS = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                if (newPWS === null) {
                    if (PWS !== null) {
                        node.error("PHASE CONTROL unknown - stop all pumps");
                    }
                    PWS = null;
                    checkPumpControl();
                    return;
                }

                if (newPWS !== PWS) {
                    PWS = newPWS;
                    if (interlockActive(PWS, true)) {
                        const msg = `PHASE CONTROL FAULT - stop all pumps`;
                        node.error(msg);
                    } else {
                        const msg = `Phase control OK`;
                        node.log(msg);
                    }
                }
                checkPumpControl();
                return;
            }

            // Total current (AI) - single sensor for all pumps
            if (node.totalCurrentMeasured && node.totalCurrentTopic && t === node.totalCurrentTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const n = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                if (n === null) {
                    totalCurrent = null;
                    checkPumpControl();
                    return;
                }
                totalCurrent = n;

                const currentLimit = evaluateCurrentLimit();
                if (!currentLimit.currentOK && currentLimit.ocDetail) {
                    node.warn(`Current limit exceeded: ${currentLimit.ocDetail}`);
                }

                checkPumpControl();
                return;
            }

            // Per-pump current sensors
            if (!node.totalCurrentMeasured) {
                for (let i = 0; i < node.pumpCurrentTopics.length && i < node.numPumps; i++) {
                    const curTopic = node.pumpCurrentTopics[i];
                    if (!curTopic || t !== curTopic) {
                        continue;
                    }
                    const val = Array.isArray(p) ? p[0] : p;
                    const n = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                    if (n === null) {
                        pumpCurrents[i] = null;
                        checkPumpControl();
                        updateStatus();
                        return;
                    }
                    pumpCurrents[i] = n;

                    const currentLimit = evaluateCurrentLimit();
                    if (!currentLimit.currentOK && currentLimit.ocDetail) {
                        node.warn(`Current limit exceeded: ${currentLimit.ocDetail}`);
                    }

                    checkPumpControl();
                    updateStatus();
                    return;
                }
            }

            // Max current limit per pump (from iolayer)
            if (node.maxCurrentTopic && t === node.maxCurrentTopic) {
                const val = Array.isArray(p) ? p[0] : p;
                const n = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                if (n === null) {
                    maxCurrentFromTopic = null;
                    checkPumpControl();
                    return;
                }
                maxCurrentFromTopic = n;
                const msg = `Max current limit per pump updated: ${maxCurrentFromTopic.toFixed(1)}A`;
                node.log(msg);
                checkPumpControl();
                return;
            }

            // Pump fuse OFF inputs (from iolayer)
            // Input: 0=OK, 1=fuse OFF/problem (pump unusable)
            for (let i = 0; i < node.pumpErrorTopics.length && i < node.numPumps; i++) {
                if (t === node.pumpErrorTopics[i]) {
                    const val = Array.isArray(p) ? p[0] : p;
                    const newFuseOFF = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                    if (newFuseOFF === null) {
                        if (pumpErrors[i] !== 1) {
                            pumpErrors[i] = 1;
                            node.warn(`Pump ${i + 1} fuse unknown - treat as OFF`);
                            if (pumpCommands[i] === 1) {
                                stopPump(i);
                                scheduleReplacementPump(i, `pump ${i + 1} fuse unknown`);
                            }
                        }
                        updateStatus();
                        return;
                    }

                    if (newFuseOFF !== pumpErrors[i]) {
                        pumpErrors[i] = newFuseOFF;

                        if (newFuseOFF === 1) {
                            node.warn(`Pump ${i + 1} fuse OFF detected - pump unusable`);

                            // Stop pump if it's running and move active command to another pump if one exists
                            if (pumpCommands[i] === 1) {
                                node.log(`Stopping pump ${i + 1} due to fuse OFF`);
                                stopPump(i);
                                scheduleReplacementPump(i, `pump ${i + 1} fuse OFF`);
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
                    const newNoRun = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                    if (newNoRun === null) {
                        if (pumpNoRun[i] !== 1) {
                            pumpNoRun[i] = 1;
                            if (pumpNoRunStartTime[i] === 0) {
                                pumpNoRunStartTime[i] = Date.now();
                            }
                            node.warn(`Pump ${i + 1} NORUN unknown`);
                            checkPumpSwapErrors();
                            updateStatus();
                        }
                        return;
                    }

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
                    const newOvercurrent = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                    if (newOvercurrent === null) {
                        if (pumpOvercurrent[i] !== 1) {
                            pumpOvercurrent[i] = 1;
                            node.error(`Pump ${i + 1} overcurrent unknown`);
                            checkPumpSwapErrors();
                            updateStatus();
                        }
                        return;
                    }

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

            // Pump runtime hours (from pump node runtimeTopic output)
            for (let i = 0; i < node.numPumps; i++) {
                const rtTopic = node.pumpRuntimeTopics[i];
                if (!rtTopic || t !== rtTopic) {
                    continue;
                }
                const val = Array.isArray(p) ? p[0] : p;
                const hours = (val == null ? null : (Number.isFinite(Number(val)) ? Number(val) : null));
                if (hours === null || hours < 0) {
                    node.warn(`Invalid runtime hours for pump ${i + 1}: ${val}`);
                    return;
                }
                if (pumpRuntimeHours[i] === null || Math.abs(pumpRuntimeHours[i] - hours) > 0.01) {
                    pumpRuntimeHours[i] = hours;
                    if (node.enableSystemLog) {
                        node.debug(`Pump ${i + 1} runtime updated: ${hours.toFixed(2)}h`);
                    }
                }
                return;
            }
        });

        node.on("close", () => {
            if (pumpReplacementTimer) {
                clearTimeout(pumpReplacementTimer);
                pumpReplacementTimer = null;
            }

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
