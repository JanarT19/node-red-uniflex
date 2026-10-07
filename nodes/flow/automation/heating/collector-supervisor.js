const fs = require("fs");
const path = require("path");
const ts = require("../../core/lib/timestamp.js");

module.exports = function (RED) {
    function CollectorSupervisorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.testControlTopic = (config.testControlTopic || "").trim();
        node.onflowTopic = (config.onflowTopic || "").trim();
        node.testCooldownSec = Math.max(0, Number(config.testCooldownSec || 60));
        node.testOpenSec = Math.max(1, Number(config.testOpenSec || 120));
        node.testInterLoopSec = Math.max(0, Number(config.testInterLoopSec || 15));
        // Single detection noise gate: minimum positive return change needed for reliable detection.
        node.testMinRiseC = Math.max(0, Number(config.testMinRiseC || 0.2));
        node.testReportPath = String(config.testReportPath || "").trim();
        node.emergencyGasTopic = (config.emergencyGasTopic || "").trim();
        node.emergencyCoolingTopic = (config.emergencyCoolingTopic || "").trim();
        node.verboseLogging = config.verboseLogging === true;
        node.verboseLoggingTopic = (config.verboseLoggingTopic || "").trim();
        node._verboseFromMsg = false;
        node.roomFcwTopics = Array.isArray(config.roomFcwTopics) ? config.roomFcwTopics : [];
        node.loops = Array.isArray(config.loops) ? config.loops : [];

        const loops = node.loops.map((row, idx) => ({
            idx,
            name: (row.name || row.returnTopic || row.forceOpenTopic || `L${idx + 1}`).trim(),
            measuringTopic: (row.measuringTopic || "").trim(),
            forceOpenTopic: (row.forceOpenTopic || "").trim(),
            returnTopic: (row.returnTopic || "").trim(),
            faultTopic: (row.faultTopic || "").trim(),
            lastReturn: null
        }));

        let latestOnflow = null;
        let testRunning = false;
        let testTimer = null;
        let currentLoopIndex = -1;
        const activeMeasuring = new Set();
        const loopFault = {};
        const inconclusiveStreak = {};
        const lastLoopResult = {};
        loops.forEach((l) => {
            loopFault[l.name] = false;
        });
        loops.forEach((l) => {
            inconclusiveStreak[l.name] = 0;
        });
        loops.forEach((l) => {
            lastLoopResult[l.name] = "unknown";
        });
        const roomFcwStateByTopic = {};
        const roomFowStateByTopic = {};
        const lastEmittedPayloadByTopic = {};
        /** At test start: snapshot room FCW states. On stop/cancel restore these exact values. */
        let roomFcwBeforeTestByTopic = {};
        let reportFilePath = "";
        let evalSampler = null;

        function verbose(message) {
            if (node.verboseLogging || node._verboseFromMsg) {
                node.warn(`[collector-supervisor:${node.name}] ${message}`);
            }
        }

        function getDefaultReportPath() {
            const safe = String(node.name || "collector")
                .replace(/[^a-zA-Z0-9_-]+/g, "_")
                .replace(/^_+|_+$/g, "");
            return `/home/nodered/heating_state/collector-supervisor-${safe || "collector"}.json`;
        }

        function resolveReportFilePath() {
            const configured = node.testReportPath || getDefaultReportPath();
            return path.isAbsolute(configured) ? configured : path.resolve(configured);
        }

        function savePersistentReport() {
            if (!reportFilePath) return;
            try {
                const dir = path.dirname(reportFilePath);
                fs.mkdirSync(dir, { recursive: true });
                const payload = {
                    version: 1,
                    updatedAt: new Date().toISOString(),
                    loopFault,
                    inconclusiveStreak,
                    lastLoopResult
                };
                fs.writeFileSync(reportFilePath, JSON.stringify(payload, null, 2), "utf8");
            } catch (e) {
                node.warn(`[collector-supervisor:${node.name}] failed to save report file ${reportFilePath}: ${e.message}`);
            }
        }

        function loadPersistentReport() {
            reportFilePath = resolveReportFilePath();
            try {
                if (!fs.existsSync(reportFilePath)) {
                    verbose(`report file not found, starting clean: ${reportFilePath}`);
                    return;
                }
                const raw = fs.readFileSync(reportFilePath, "utf8");
                const data = JSON.parse(raw || "{}");
                const storedFault = data.loopFault && typeof data.loopFault === "object" ? data.loopFault : {};
                const storedInc = data.inconclusiveStreak && typeof data.inconclusiveStreak === "object" ? data.inconclusiveStreak : {};
                const storedResult = data.lastLoopResult && typeof data.lastLoopResult === "object" ? data.lastLoopResult : {};
                loops.forEach((l) => {
                    if (typeof storedFault[l.name] === "boolean") loopFault[l.name] = storedFault[l.name];
                    const n = Number(storedInc[l.name]);
                    if (Number.isFinite(n) && n >= 0) inconclusiveStreak[l.name] = Math.floor(n);
                    if (typeof storedResult[l.name] === "string") lastLoopResult[l.name] = storedResult[l.name];
                });
                node.log(`[collector-supervisor:${node.name}] loaded report: ${reportFilePath}`);
            } catch (e) {
                node.warn(`[collector-supervisor:${node.name}] failed to load report file ${reportFilePath}: ${e.message}`);
            }
        }

        function emit(msg, reason) {
            if (msg && msg.topic) {
                node.send(msg);
                const previous = lastEmittedPayloadByTopic[msg.topic];
                const changed = previous !== msg.payload;
                lastEmittedPayloadByTopic[msg.topic] = msg.payload;
                if (changed) {
                    const why = reason ? `, reason=${reason}` : "";
                    const trans = previous === undefined ? `->${msg.payload}` : `${previous}->${msg.payload}`;
                    verbose(`OUT topic=${msg.topic} payload ${trans}${why}`);
                }
            }
        }

        function getRoomFcwTopics() {
            const set = new Set();
            (node.roomFcwTopics || []).forEach((row) => {
                const t = (row && row.topic ? String(row.topic) : "").trim();
                if (t) set.add(t);
            });
            // Backward compatibility for older config style.
            const legacyTopic = (config.roomFcwTopic || "").trim();
            if (legacyTopic) set.add(legacyTopic);
            (node.loops || []).forEach((row) => {
                const t = (row && row.roomFcwTopic ? String(row.roomFcwTopic) : "").trim();
                if (t) set.add(t);
            });
            return Array.from(set);
        }

        function getRoomForceOpenTopics() {
            const set = new Set();
            (node.roomFcwTopics || []).forEach((row) => {
                const t = (row && row.forceOpenTopic ? String(row.forceOpenTopic) : "").trim();
                if (t) set.add(t);
            });
            // Backward compatibility for older config style.
            (node.loops || []).forEach((row) => {
                const t = (row && row.roomForceOpenTopic ? String(row.roomForceOpenTopic) : "").trim();
                if (t) set.add(t);
            });
            return Array.from(set);
        }

        function asActiveFlag(payload) {
            const v = (payload == null || !Number.isFinite(Number(payload)) ? null : (Number(payload) !== 0 ? 1 : 0));
            if (v === null) return null;
            return v !== 0;
        }

        function updateRoomOverrideState(topic, payload) {
            const fcwTopics = new Set(getRoomFcwTopics());
            const fowTopics = new Set(getRoomForceOpenTopics());
            const active = asActiveFlag(payload);
            if (active === null) return [];
            const changes = [];
            if (fcwTopics.has(topic)) {
                const prev = !!roomFcwStateByTopic[topic];
                if (prev !== active) changes.push(`FCW ${prev ? 1 : 0}->${active ? 1 : 0}`);
                roomFcwStateByTopic[topic] = active;
            }
            if (fowTopics.has(topic)) {
                const prev = !!roomFowStateByTopic[topic];
                if (prev !== active) changes.push(`FOW ${prev ? 1 : 0}->${active ? 1 : 0}`);
                roomFowStateByTopic[topic] = active;
            }
            return changes;
        }

        function getActiveRoomOverrideTopics() {
            const active = [];
            Object.keys(roomFcwStateByTopic).forEach((t) => {
                if (roomFcwStateByTopic[t]) active.push(t);
            });
            Object.keys(roomFowStateByTopic).forEach((t) => {
                if (roomFowStateByTopic[t]) active.push(t);
            });
            return active;
        }

        /** Topics that block the test: only room forced-open (FOW). FCW is always ignored (we use it for the test). */
        function getBlockingRoomOverrideTopics() {
            const blocking = [];
            Object.keys(roomFowStateByTopic).forEach((t) => {
                if (roomFowStateByTopic[t]) blocking.push(t);
            });
            return blocking;
        }

        function hasBlockingRoomOverrides() {
            return getBlockingRoomOverrideTopics().length > 0;
        }

        function sendAllRoomFcw(value) {
            getRoomFcwTopics().forEach((t) => emit({ topic: t, payload: value ? 1 : 0 }, "sendAllRoomFcw"));
        }

        function syncRoomFcw() {
            // Room FCW is owned only during explicit collector test (TSTW=1 flow).
            // Measuring signals are informative and must not start forced-close on their own.
            // Do NOT send FCW=0 when idle -- that would overwrite manual or external FCW=1.
            const weOwnFcw = testRunning;
            if (weOwnFcw) {
                verbose(`syncRoomFcw -> FCW=1 (testRunning=${testRunning}, activeMeasuring=${activeMeasuring.size})`);
                sendAllRoomFcw(1);
            } else {
                verbose(`syncRoomFcw -> no output (test not running; preserving external/manual FCW)`);
            }
        }

        function sendAllForceOpen(value) {
            loops.forEach((l) => {
                if (l.forceOpenTopic) emit({ topic: l.forceOpenTopic, payload: value ? 1 : 0 }, "sendAllForceOpen");
            });
        }

        function sendLoopForceOpen(loop, value) {
            // Per-loop CFO: 1 = force this loop open (override for test); 0 = no override (room FCW then closes it).
            if (loop && loop.forceOpenTopic) emit({ topic: loop.forceOpenTopic, payload: value ? 1 : 0 }, "sendLoopForceOpen");
        }

        function publishFaults() {
            loops.forEach((l) => {
                if (!l.faultTopic) return;
                emit({ topic: l.faultTopic, payload: loopFault[l.name] ? 1 : 0 }, "publishFaults");
            });
        }

        function clearTimer() {
            if (testTimer) {
                clearTimeout(testTimer);
                testTimer = null;
                verbose(`timer cleared`);
            }
        }

        function startEvalSampling(loop, baseline) {
            const startedAt = Date.now();
            evalSampler = { loopName: loop.name, baseline, startedAt, samples: [] };
            // Seed with initial snapshot; all following samples are appended on incoming return updates.
            const row = { tSec: 0 };
            loops.forEach((l) => {
                row[l.name] = Number.isFinite(l.lastReturn) ? l.lastReturn : null;
            });
            evalSampler.samples.push(row);
        }

        function stopEvalSampling() {
            if (!evalSampler) return [];
            const samples = evalSampler.samples || [];
            evalSampler = null;
            return samples;
        }

        function appendEvalSampleFromIncoming() {
            if (!evalSampler) return;
            const row = { tSec: (Date.now() - evalSampler.startedAt) / 1000 };
            loops.forEach((l) => {
                row[l.name] = Number.isFinite(l.lastReturn) ? l.lastReturn : null;
            });
            const prev = evalSampler.samples[evalSampler.samples.length - 1];
            // Avoid duplicate rows when no values changed.
            if (prev) {
                let same = true;
                for (let i = 0; i < loops.length; i++) {
                    const key = loops[i].name;
                    if (prev[key] !== row[key]) {
                        same = false;
                        break;
                    }
                }
                if (same) return;
            }
            evalSampler.samples.push(row);
        }

        function scheduleNext(ms, fn) {
            clearTimer();
            verbose(`schedule next step in ${ms}ms`);
            testTimer = setTimeout(fn, ms);
        }

        function stopTest(reason, writeControlZero) {
            clearTimer();
            stopEvalSampling();
            testRunning = false;
            currentLoopIndex = -1;
            verbose(`stopTest reason=${reason}, writeControlZero=${!!writeControlZero}`);
            sendAllForceOpen(0);
            // Restore room FCW to pre-test snapshot for BOTH completed and cancelled tests.
            getRoomFcwTopics().forEach((t) => {
                const before = !!roomFcwBeforeTestByTopic[t];
                emit({ topic: t, payload: before ? 1 : 0 }, "stopTest restore pre-test FCW state");
            });
            publishFaults();
            const meas = activeMeasuring.size;
            node.log(`[collector-supervisor:${node.name}] test finished: ${reason}`);
            node.status({ fill: meas > 0 ? "green" : "blue", shape: "dot", text: `Idle (${reason}), measuring:${meas}` });
            if (node.testControlTopic && (reason === "completed" || writeControlZero)) {
                emit({ topic: node.testControlTopic, payload: 0 }, "stopTest reset test control");
            }
            if (node.emergencyGasTopic) emit({ topic: node.emergencyGasTopic, payload: 0 }, "stopTest clear emergency gas");
            if (node.emergencyCoolingTopic) emit({ topic: node.emergencyCoolingTopic, payload: 0 }, "stopTest clear emergency cooling");
        }

        function setLoopFault(loopName, faultActive, reason) {
            const prev = !!loopFault[loopName];
            const next = !!faultActive;
            loopFault[loopName] = next;
            if (prev !== next) {
                node.warn(`[collector-supervisor:${node.name}] Loop ${loopName} fault ${prev ? 1 : 0}->${next ? 1 : 0}${reason ? ` (${reason})` : ""}`);
            } else if (reason) {
                node.warn(`[collector-supervisor:${node.name}] Loop ${loopName} ${next ? "fault" : "ok"}: ${reason}`);
            }
        }

        function markFault(loop, why) {
            if (!loop) return;
            inconclusiveStreak[loop.name] = 0;
            lastLoopResult[loop.name] = "fail";
            setLoopFault(loop.name, true, why);
            savePersistentReport();
        }

        function markPass(loop, why) {
            if (!loop) return;
            inconclusiveStreak[loop.name] = 0;
            lastLoopResult[loop.name] = "pass";
            setLoopFault(loop.name, false, why);
            savePersistentReport();
        }

        function markInconclusive(loop, why) {
            if (!loop) return;
            const prev = Number(inconclusiveStreak[loop.name] || 0);
            const next = prev + 1;
            inconclusiveStreak[loop.name] = next;
            lastLoopResult[loop.name] = "inconclusive";
            if (next >= 2) {
                setLoopFault(loop.name, true, `inconclusive ${next}x in a row: ${why}`);
            } else {
                // first inconclusive: keep fault state unchanged
                node.warn(`[collector-supervisor:${node.name}] Loop ${loop.name} inconclusive (${next}/2): ${why}; fault unchanged (${loopFault[loop.name] ? 1 : 0})`);
            }
            savePersistentReport();
        }

        function pearson(xs, ys) {
            const n = Math.min(xs.length, ys.length);
            if (n < 3) return NaN;
            let sx = 0,
                sy = 0;
            for (let i = 0; i < n; i++) {
                sx += xs[i];
                sy += ys[i];
            }
            const mx = sx / n,
                my = sy / n;
            let num = 0,
                dx2 = 0,
                dy2 = 0;
            for (let i = 0; i < n; i++) {
                const dx = xs[i] - mx;
                const dy = ys[i] - my;
                num += dx * dy;
                dx2 += dx * dx;
                dy2 += dy * dy;
            }
            const den = Math.sqrt(dx2 * dy2);
            if (!Number.isFinite(den) || den <= 0) return NaN;
            return num / den;
        }

        function evaluateLoop(loop, baseline, samples) {
            if (!Array.isArray(samples) || samples.length < 3) {
                markInconclusive(loop, "too few samples for correlation");
                return;
            }
            const tauSec = Math.max(60, Math.floor(node.testOpenSec / 3));
            const templateBySample = samples.map((s) => 1 - Math.exp(-Math.max(0, Number(s.tSec) || 0) / tauSec));

            const metrics = [];
            loops.forEach((l) => {
                const b = baseline[l.name];
                if (!Number.isFinite(b)) return;
                const ys = [];
                const xs = [];
                const ts = [];
                for (let i = 0; i < samples.length; i++) {
                    const v = samples[i][l.name];
                    const t = Number(samples[i].tSec);
                    if (!Number.isFinite(v)) continue;
                    ys.push(v - b);
                    xs.push(templateBySample[i]);
                    ts.push(Number.isFinite(t) ? t : 0);
                }
                if (ys.length < 3) return;
                const corr = pearson(xs, ys);
                const amp = Math.max.apply(null, ys);
                const score = (Number.isFinite(corr) ? corr : -1) * Math.max(0, amp);
                const firstIdx = 0;
                const lastIdx = ys.length - 1;
                const dt = Math.max(0, ts[lastIdx] - ts[firstIdx]);
                const dT = ys[lastIdx] - ys[firstIdx];
                const dTdt = dt > 0 ? dT / dt : 0;
                metrics.push({
                    name: l.name,
                    corr: Number.isFinite(corr) ? corr : -1,
                    amp: Number.isFinite(amp) ? amp : 0,
                    score,
                    dT: Number.isFinite(dT) ? dT : 0,
                    dTdt: Number.isFinite(dTdt) ? dTdt : 0
                });
            });
            if (!metrics.length) {
                markInconclusive(loop, "no valid loop metrics");
                return;
            }
            const target = metrics.find((m) => m.name === loop.name);
            if (!target) {
                const available = metrics.map((m) => m.name).join(", ") || "(none)";
                const baselineKnown = Number.isFinite(baseline[loop.name]) ? baseline[loop.name].toFixed(2) : "null";
                markFault(loop, `missing target loop metric: target=${loop.name}, baseline=${baselineKnown}, sampleCount=${samples.length}, available=[${available}]`);
                return;
            }
            let winner = metrics[0];
            for (let i = 1; i < metrics.length; i++) if (metrics[i].score > winner.score) winner = metrics[i];
            // Derivative-based detection for heating season:
            // compare largest POSITIVE dT/dt only (cooling/negative derivatives must not win).
            let derivativeWinner = metrics[0];
            for (let i = 1; i < metrics.length; i++) {
                if (metrics[i].dTdt > derivativeWinner.dTdt) derivativeWinner = metrics[i];
            }
            const maxAmp = metrics.reduce((m, x) => Math.max(m, x.amp), 0);
            const minDetect = node.testMinRiseC;
            const maxAbsDT = metrics.reduce((m, x) => Math.max(m, Math.abs(x.dT)), 0);
            const maxPosDTdt = metrics.reduce((m, x) => Math.max(m, x.dTdt), 0);

            // Primary decision (existing model)
            let primaryState = "pass";
            let primaryReason = `reacted as expected (amp=${target.amp.toFixed(2)}C, corr=${target.corr.toFixed(3)}, score=${target.score.toFixed(3)})`;
            if (target.amp < minDetect && maxAmp < minDetect) {
                primaryState = "inconclusive";
                primaryReason = `low signal: target amp=${target.amp.toFixed(2)}C, max amp=${maxAmp.toFixed(2)}C, min=${minDetect}C`;
            } else if (winner.name !== loop.name && winner.amp >= minDetect && winner.score > target.score + 0.03) {
                primaryState = "fault";
                primaryReason = `wrong loop correlated most (${winner.name}, score=${winner.score.toFixed(3)} vs target=${target.score.toFixed(3)})`;
            } else if (target.amp < minDetect || target.corr < 0.2 || target.score <= 0) {
                primaryState = "fault";
                primaryReason = `weak target reaction (amp=${target.amp.toFixed(2)}C, corr=${target.corr.toFixed(3)}, score=${target.score.toFixed(3)})`;
            }

            // Secondary decision (KISS): largest absolute derivative / delta over the test window.
            let secondaryState = "pass";
            let secondaryReason = `target strongest derivative (winner=${derivativeWinner.name}, target dT=${target.dT.toFixed(3)}C, dTdt=${target.dTdt.toFixed(5)}C/s)`;
            if (Math.abs(target.dT) < minDetect && maxAbsDT < minDetect && maxPosDTdt <= 0) {
                secondaryState = "inconclusive";
                secondaryReason = `low derivative signal: target |dT|=${Math.abs(target.dT).toFixed(3)}C, max |dT|=${maxAbsDT.toFixed(3)}C, max +dTdt=${maxPosDTdt.toFixed(5)}C/s, min=${minDetect}C`;
            } else if (derivativeWinner.dTdt > 0 && derivativeWinner.name !== loop.name) {
                secondaryState = "fault";
                secondaryReason = `wrong loop largest positive derivative (${derivativeWinner.name}, target dTdt=${target.dTdt.toFixed(5)}C/s, winner dTdt=${derivativeWinner.dTdt.toFixed(5)}C/s)`;
            }

            // Final outcome: use decisive result, prefer primary on conflict.
            let finalState = primaryState;
            let outcomeTag = "primary";
            if (primaryState === "inconclusive" && secondaryState !== "inconclusive") {
                finalState = secondaryState;
                outcomeTag = "secondary";
            } else if (secondaryState === "inconclusive" && primaryState !== "inconclusive") {
                finalState = primaryState;
                outcomeTag = "primary";
            } else if (primaryState === secondaryState) {
                finalState = primaryState;
                outcomeTag = "both";
            } else if (primaryState !== "inconclusive" && secondaryState !== "inconclusive" && primaryState !== secondaryState) {
                finalState = primaryState;
                outcomeTag = "primary_conflict";
            }

            node.warn(
                `[collector-supervisor:${node.name}] Loop ${loop.name} decision ` +
                    `primary=${primaryState} (${primaryReason}); ` +
                    `secondary=${secondaryState} (${secondaryReason}); ` +
                    `outcome=${finalState} via ${outcomeTag}`
            );

            if (finalState === "fault") {
                markFault(loop, `outcome=${outcomeTag}; primary=${primaryState}; secondary=${secondaryState}`);
                if (primaryState === "fault" && winner.name !== loop.name) {
                    const wrong = loops.find((l) => l.name === winner.name);
                    if (wrong) markFault(wrong, `unexpected strongest primary response while testing ${loop.name}`);
                }
                return;
            }
            if (finalState === "inconclusive") {
                markInconclusive(loop, `outcome=${outcomeTag}; primary=${primaryState}; secondary=${secondaryState}`);
                return;
            }
            markPass(loop, `outcome=${outcomeTag}; primary=${primaryState}; secondary=${secondaryState}`);
        }

        function runLoopTest(loopIndex) {
            if (loopIndex >= loops.length) return stopTest("completed");
            currentLoopIndex = loopIndex;

            const loop = loops[loopIndex];
            node.log(`[collector-supervisor:${node.name}] testing loop ${loopIndex + 1}/${loops.length}: ${loop.name}`);
            const baseline = {};
            loops.forEach((l) => {
                baseline[l.name] = l.lastReturn;
            });
            verbose(`runLoopTest loop=${loop.name} baseline=${JSON.stringify(baseline)}`);

            sendAllForceOpen(0);
            sendLoopForceOpen(loop, 1);
            node.status({ fill: "yellow", shape: "dot", text: `Testing ${loop.name}: open ${node.testOpenSec}s` });
            startEvalSampling(loop, baseline);

            scheduleNext(node.testOpenSec * 1000, () => {
                sendLoopForceOpen(loop, 0);
                const samples = stopEvalSampling();
                evaluateLoop(loop, baseline, samples);
                publishFaults();
                scheduleNext(node.testInterLoopSec * 1000, () => runLoopTest(loopIndex + 1));
            });
        }

        function startTest() {
            if (testRunning) return;
            if (hasBlockingRoomOverrides()) {
                const active = getBlockingRoomOverrideTopics().join(", ");
                node.warn(`[collector-supervisor:${node.name}] cannot start test due to active room forced-open: ${active}`);
                node.status({ fill: "yellow", shape: "ring", text: "Test blocked: room force signal active" });
                if (node.testControlTopic) emit({ topic: node.testControlTopic, payload: 0 });
                return;
            }
            node.log(`[collector-supervisor:${node.name}] test started: cooldown ${node.testCooldownSec}s, then ${loops.length} loop(s)`);
            // Snapshot room FCW state so on stop/cancel we can restore exact pre-test values.
            roomFcwBeforeTestByTopic = {};
            getRoomFcwTopics().forEach((t) => {
                roomFcwBeforeTestByTopic[t] = !!roomFcwStateByTopic[t];
            });
            const activeBefore = Object.keys(roomFcwBeforeTestByTopic).filter((t) => roomFcwBeforeTestByTopic[t]);
            verbose(`startTest FCW-active-before=${activeBefore.join(", ") || "(none)"}`);
            testRunning = true;
            currentLoopIndex = -1;
            syncRoomFcw();
            sendAllForceOpen(0);
            node.status({ fill: "yellow", shape: "dot", text: `Test cooldown ${node.testCooldownSec}s` });
            scheduleNext(node.testCooldownSec * 1000, () => runLoopTest(0));
        }

        function handleTestControl(payload) {
            const v = Number(payload);
            if (!Number.isFinite(v)) return;
            if (v === 1) {
                if (!testRunning) node.log(`[collector-supervisor:${node.name}] test control received: start (topic=${node.testControlTopic})`);
                startTest();
            } else if (v === 0) {
                if (testRunning) {
                    node.log(`[collector-supervisor:${node.name}] test control received: cancel`);
                    // External 0: no need to write 0 back.
                    stopTest("cancelled", false);
                }
                // When idle, payload 0 is a no-op (e.g. other TSTW members from same datastream); do not log.
            }
        }

        function findMeasuringLoopByTopic(topic) {
            const direct = loops.find((l) => l.measuringTopic && l.measuringTopic === topic);
            if (direct) return direct;
            // Backward compatibility with old base-topic config (e.g. CME2W -> CME2W.n).
            const base = (config.measuringTopic || "").trim();
            if (base && (topic === base || topic.indexOf(base + ".") === 0)) {
                return { name: topic, measuringTopic: topic };
            }
            return null;
        }

        function handleMeasuringSignal(loop, payload) {
            // payload semantics:
            // 1 -> this loop is in emergency measuring window
            // 0 -> this loop is not in emergency measuring window
            const v = Number(payload);
            if (!Number.isFinite(v)) return;
            let changed = false;
            if (v === 1) {
                const before = activeMeasuring.size;
                activeMeasuring.add(loop.name);
                changed = activeMeasuring.size !== before;
            } else if (v === 0) {
                const before = activeMeasuring.size;
                activeMeasuring.delete(loop.name);
                changed = activeMeasuring.size !== before;
            } else return;
            if (!changed) return;
            verbose(`IN measuring topic=${loop.measuringTopic || loop.name} payload=${v}, activeMeasuring=${activeMeasuring.size}`);

            syncRoomFcw();
            if (!testRunning) {
                const fcwCount = getRoomFcwTopics().length;
                const meas = activeMeasuring.size;
                node.status({ fill: meas > 0 ? "green" : "blue", shape: "dot", text: `Idle, measuring:${meas}, FCW:${fcwCount}` });
            }
        }

        node.on("input", function (msg) {
            const topic = String(msg.topic || "");
            if (node.verboseLoggingTopic && topic === node.verboseLoggingTopic) {
                const bit = (msg.payload == null || !Number.isFinite(Number(msg.payload)) ? null : (Number(msg.payload) !== 0 ? 1 : 0));
                if (bit === null) return;
                node._verboseFromMsg = !!bit;
                node.warn(`[collector-supervisor:${node.name}] verbose logging ${node._verboseFromMsg ? "ON" : "OFF"} (from topic=${topic})`);
                return;
            }
            const roomOverrideChanges = updateRoomOverrideState(topic, msg.payload);
            if (roomOverrideChanges.length > 0) {
                verbose(`IN topic=${topic} payload=${Number(msg.payload)} override ${roomOverrideChanges.join(", ")}`);
            }
            if (testRunning && hasBlockingRoomOverrides()) {
                const active = getBlockingRoomOverrideTopics().join(", ");
                node.warn(`[collector-supervisor:${node.name}] aborting test due to active room forced-open: ${active}`);
                stopTest("aborted: room force signal active", true);
                return;
            }
            const measuringLoop = findMeasuringLoopByTopic(topic);
            if (measuringLoop) {
                handleMeasuringSignal(measuringLoop, msg.payload);
                return;
            }
            if (node.testControlTopic && topic === node.testControlTopic) {
                handleTestControl(msg.payload);
                return;
            }
            if (node.onflowTopic && topic === node.onflowTopic) {
                const f = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                const prev = latestOnflow;
                if (f !== null && prev !== f) {
                    latestOnflow = f;
                    const trans = Number.isFinite(prev) ? `${prev}->${f}` : `->${f}`;
                    verbose(`IN onflow topic=${topic} value ${trans}`);
                }
                return;
            }
            const loop = loops.find((l) => l.returnTopic && l.returnTopic === topic);
            if (loop) {
                const v = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                const prev = loop.lastReturn;
                if (v !== null && prev !== v) {
                    loop.lastReturn = v;
                    appendEvalSampleFromIncoming();
                    const trans = Number.isFinite(prev) ? `${prev}->${v}` : `->${v}`;
                    verbose(`IN return loop=${loop.name} topic=${topic} value ${trans}`);
                }
            }
        });

        node.on("close", function () {
            clearTimer();
            stopEvalSampling();
            savePersistentReport();
        });

        loadPersistentReport();
        node.log(
            `[collector-supervisor:${node.name}] ready; testControl=${node.testControlTopic || "(none)"}, loops=${loops.length}, roomFCW=${getRoomFcwTopics().length}, roomFOW=${getRoomForceOpenTopics().length}`
        );
        verbose(`ready verbose=${node.verboseLogging}, verboseTopic=${node.verboseLoggingTopic || "(none)"}, reportPath=${reportFilePath || "(none)"}`);
        node.status({ fill: "blue", shape: "dot", text: `Idle, measuring:0, FCW:${getRoomFcwTopics().length}` });
    }

    RED.nodes.registerType("uniflex-collector-supervisor", CollectorSupervisorNode);
};
