const http = require("http");
const net = require("net");
const ts = require("../../lib/timestamp.js");

module.exports = function (RED) {
    function WriteDataStreamsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);
        node.warn("[write-data-streams] runtime loaded: VERSION 2026-02-21 v6");

        // Retrieve configuration settings
        node.name = config.name;
        node.outputMode = config.outputMode;
        node.payloadType = config.payloadType;
        node.transport = (config.transport || "http").toLowerCase();
        if (!["http", "raw_tcp"].includes(node.transport)) {
            node.transport = "http";
        }
        node.tcpPort = Number.isInteger(parseInt(config.tcpPort, 10)) ? parseInt(config.tcpPort, 10) : 19080;
        node.mappings = config.mappings || [];
        node.debugTopics = (config.debugTopics || "").trim(); // comma-separated topic prefixes; empty = no debug logging
        node.mappings = dedupeMappings(node.mappings);

        function buildRowsByTopic(mappings) {
            const map = Object.create(null);
            mappings.forEach((row, i) => {
                const topic = row?.topic;
                if (!topic || typeof topic !== "string") {
                    return;
                }
                const key = topic.trim();
                if (!key) {
                    return;
                }
                if (!map[key]) {
                    map[key] = [];
                }
                map[key].push({ row, index: i });
            });
            return map;
        }

        const rowsByTopic = buildRowsByTopic(node.mappings);

        // Stores latest output of each row to compare against
        const previousValues = {};

        // Temporary variables
        const requestInProgress = {};

        // Batching: collect messages arriving within a short time window
        let messageBatch = [];
        let batchTimeout = null;
        const BATCH_DELAY_MS = 50; // Wait 50ms for more messages before sending (increased from 20ms)
        const discreteCoerceWarnTsByTopic = {};
        const tcpQueueByKey = new Map(); // key.member -> { key, value, forced }
        let tcpSocket = null;
        let tcpConnected = false;
        let tcpConnecting = false;
        let tcpReconnectTimer = null;
        let tcpPostHttpProbeTimer = null;
        let tcpReconnectDelayMs = 1000;
        let activityBlinkOn = false;
        let lastServicesWarning = null;

        function nextActivityShape() {
            activityBlinkOn = !activityBlinkOn;
            return activityBlinkOn ? "dot" : "ring";
        }

        // Measure latency of HTTP requests
        const measureDelay = true;
        let lastSendTs = null;
        const latencySamplesMs = [];
        const LATENCY_REPORT_EVERY_MS = 60 * 1000;
        let lastLatencyReportTs = Date.now();

        function dedupeMappings(mappings) {
            const list = Array.isArray(mappings) ? mappings : [];
            const seen = new Set();
            let dropped = 0;
            const unique = [];
            list.forEach((row) => {
                const svcKey = row?.keyNameSelect || row?.keyNameManual || "";
                const index = Number.isInteger(row?.index) ? row.index : parseInt(row?.index, 10);
                const sig = `${svcKey}|${row?.channelType || ""}|${Number.isInteger(index) ? index : ""}|${row?.topic || ""}`;
                if (seen.has(sig)) {
                    dropped += 1;
                    return;
                }
                seen.add(sig);
                unique.push(row);
            });
            if (dropped > 0) {
                node.warn(`[write-data-streams] Ignored ${dropped} duplicate mapping(s) from config.`);
            }
            return unique;
        }

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        function warnInvalidServicesMetadata() {
            const warning = node.controller?.servicesError || null;
            if (!warning) {
                lastServicesWarning = null;
                return;
            }
            if (warning !== lastServicesWarning) {
                node.warn(`[write-data-streams] ${warning}; configured coefficients and labels may be affected`);
                lastServicesWarning = warning;
            }
        }

        function buildTcpFrame(postData = {}) {
            const localhost = postData.localhost || {};
            return (
                JSON.stringify({
                    localhost: localhost,
                    forced: !!postData.forced
                }) + "\n"
            );
        }

        function queueTcpLatest(postData = {}) {
            const localhost = postData.localhost || {};
            const forced = !!postData.forced;
            Object.keys(localhost).forEach((k) => {
                tcpQueueByKey.set(k, { key: k, value: localhost[k], forced: forced });
            });
        }

        function clearQueuedFromPostDataIfUnchanged(postData = {}) {
            const localhost = postData.localhost || {};
            Object.keys(localhost).forEach((k) => {
                const queued = tcpQueueByKey.get(k);
                if (!queued) return;
                if (JSON.stringify(queued.value) === JSON.stringify(localhost[k])) {
                    tcpQueueByKey.delete(k);
                }
            });
        }

        function flushTcpQueue() {
            if (!tcpConnected || !tcpSocket || tcpQueueByKey.size === 0) return;
            const payload = { localhost: {} };
            let forced = false;
            for (const [, item] of tcpQueueByKey) {
                payload.localhost[item.key] = item.value;
                forced ||= !!item.forced;
            }
            if (forced) payload.forced = true;
            try {
                const frame = buildTcpFrame(payload);
                tcpSocket.write(frame);
                tcpQueueByKey.clear();
                node.status({ fill: "blue", shape: "dot", text: "RAW TCP connected, flushed queue" });
            } catch (err) {
                node.warn(`[write-data-streams] TCP flush failed: ${err.message}`);
                node.status({ fill: "red", shape: "dot", text: "TCP flush failed" });
            }
        }

        function scheduleTcpReconnect() {
            if (tcpReconnectTimer || node.transport !== "raw_tcp") return;
            const delay = tcpReconnectDelayMs;
            tcpReconnectTimer = setTimeout(() => {
                tcpReconnectTimer = null;
                connectTcp();
            }, delay);
            tcpReconnectDelayMs = Math.min(15000, Math.floor(tcpReconnectDelayMs * 1.5));
            node.status({ fill: "red", shape: "dot", text: `TCP reconnect in ${delay}ms` });
        }

        function scheduleTcpPostHttpProbe(delayMs = 1500) {
            if (node.transport !== "raw_tcp" || tcpConnected || tcpConnecting) return;
            if (tcpPostHttpProbeTimer) return;
            tcpPostHttpProbeTimer = setTimeout(() => {
                tcpPostHttpProbeTimer = null;
                connectTcp();
            }, delayMs);
        }

        function connectTcp() {
            if (node.transport !== "raw_tcp" || tcpConnecting || tcpConnected) return;
            tcpConnecting = true;
            const socket = net.createConnection({ host: node.controller.host, port: node.tcpPort }, () => {
                tcpSocket = socket;
                tcpConnected = true;
                tcpConnecting = false;
                tcpReconnectDelayMs = 1000;
                socket.setKeepAlive(true, 10000);
                node.log(`[write-data-streams] RAW TCP connected: ${node.controller.host}:${node.tcpPort}`);
                node.status({ fill: "blue", shape: "dot", text: `RAW TCP connected ${node.controller.host}:${node.tcpPort}` });
                flushTcpQueue();
            });

            socket.on("error", (err) => {
                tcpConnecting = false;
                tcpConnected = false;
                if (tcpSocket === socket) tcpSocket = null;
                node.warn(`[write-data-streams] TCP error: ${err.message}`);
                node.status({ fill: "red", shape: "dot", text: `TCP error: ${err.message}` });
                scheduleTcpReconnect();
            });

            socket.on("close", () => {
                tcpConnecting = false;
                tcpConnected = false;
                if (tcpSocket === socket) tcpSocket = null;
                node.status({ fill: "red", shape: "dot", text: "RAW TCP connection closed" });
                scheduleTcpReconnect();
            });
        }

        if (node.transport === "raw_tcp") {
            connectTcp();
        }

        function recordLatencySample(sampleMs) {
            if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
            latencySamplesMs.push(sampleMs);
            const now = Date.now();
            if (now - lastLatencyReportTs < LATENCY_REPORT_EVERY_MS) return;
            lastLatencyReportTs = now;
            if (latencySamplesMs.length === 0) return;
            const sorted = latencySamplesMs.slice().sort((a, b) => a - b);
            const pickQuantile = (q) => {
                const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
                return sorted[idx];
            };
            const p50 = pickQuantile(0.5);
            const p95 = pickQuantile(0.95);
            const max = sorted[sorted.length - 1];
            node.log(
                `[write-data-streams] latency stats (last ${LATENCY_REPORT_EVERY_MS / 1000}s, n=${sorted.length}): ` +
                    `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`
            );
            latencySamplesMs.length = 0;
        }

        // Flag to track if we've logged controller config info (log once when data becomes available)
        let hasLoggedControllerConfig = true;

        // Function to log controller config information (called when data becomes available)
        function logControllerConfig() {
            if (hasLoggedControllerConfig || !node.controller) return;

            const channels = node.controller.channels || {};
            const channelKeys = Object.keys(channels).sort();

            // Only log if we have actual data (not just empty objects)
            if (channelKeys.length > 0) {
                node.log(`[Write Data Streams] Controller config loaded`);
                node.log(`[Write Data Streams] Total datastreams in channels (unfiltered): ${channelKeys.length}`);

                // Log full controller data for debugging - split into chunks if too large
                const channelsJson = JSON.stringify(channels, null, 2);
                const maxLogLength = 5000; // Split into chunks if larger
                if (channelsJson.length > maxLogLength) {
                    node.log(`[Write Data Streams] Full controller channels data (split into chunks due to size):`);
                    for (let i = 0; i < channelsJson.length; i += maxLogLength) {
                        const chunk = channelsJson.substring(i, i + maxLogLength);
                        node.log(`[Write Data Streams] Channels chunk ${Math.floor(i / maxLogLength) + 1}: ${chunk}`);
                    }
                } else {
                    node.log(`[Write Data Streams] Full controller channels data: ${channelsJson}`);
                }

                // Specifically log DO1W datastream details if present
                if (channels.DO1W) {
                    node.log(`[Write Data Streams] DO1W datastream details:`);
                    node.log(`[Write Data Streams]   Raw DO1W channels: ${JSON.stringify(channels.DO1W, null, 2)}`);
                    const do1wMembers = Object.values(channels.DO1W);
                    node.log(`[Write Data Streams]   DO1W has ${do1wMembers.length} members:`);
                    do1wMembers.forEach((member) => {
                        node.log(
                            `[Write Data Streams]     Member ${member.member}: regtype='${member.regtype}', _output=${member._output}, _type='${member._type || "N/A"}', desc='${
                                member.desc || "N/A"
                            }'`
                        );
                    });
                } else {
                    node.log(`[Write Data Streams]   DO1W datastream NOT found in channels`);
                }

                // Apply our own writability rules to count what's available
                // Rules: s/s!/r always writable; h/c/h!/c! writable if _output is true
                let writableCount = 0;
                const writableKeys = [];

                channelKeys.forEach((key) => {
                    const keyChannels = channels[key] || {};
                    const members = Object.values(keyChannels);

                    // Check if this datastream has at least one writable member
                    const hasWritableMember = members.some((member) => {
                        const regtype = member.regtype;
                        const hasOutput = member._output === true;

                        if (["s", "s!", "r", "h", "c"].includes(regtype)) {
                            return true;
                        }
                        if (["h!", "c!"].includes(regtype)) {
                            return hasOutput;
                        }
                        return false;
                    });

                    if (hasWritableMember) {
                        writableCount++;
                        writableKeys.push(key);
                    }
                });

                node.log(`[Write Data Streams] Datastreams passing our writability rules: ${writableCount} of ${channelKeys.length}`);

                // Show excluded datastreams and why they were excluded
                const excludedKeys = channelKeys.filter((k) => !writableKeys.includes(k));
                if (excludedKeys.length > 0) {
                    node.log(`[Write Data Streams] ⚠ Excluded datastreams (${excludedKeys.length}): ${excludedKeys.join(", ")}`);
                    // Show detailed exclusion reasons
                    excludedKeys.forEach((key) => {
                        const keyChannels = channels[key] || {};
                        const members = Object.values(keyChannels);
                        if (members.length > 0) {
                            const memberReasons = members
                                .map((m) => {
                                    const regtype = m.regtype;
                                    const memberIdx = m.member;
                                    const hasOutput = m._output === true;

                                    if (["s", "s!", "r"].includes(regtype)) {
                                        return `m${memberIdx}:${regtype}(should be writable - unexpected exclusion)`;
                                    } else if (["h", "c", "h!", "c!"].includes(regtype)) {
                                        if (!hasOutput) {
                                            return `m${memberIdx}:${regtype}(_output=${hasOutput}, needs _output=true per rules)`;
                                        } else {
                                            return `m${memberIdx}:${regtype}(_output=true but excluded - unexpected)`;
                                        }
                                    } else {
                                        return `m${memberIdx}:${regtype}(unknown regtype)`;
                                    }
                                })
                                .join(", ");
                            node.log(`[Write Data Streams]   - ${key}: ${memberReasons}`);
                        } else {
                            node.log(`[Write Data Streams]   - ${key}: no members found`);
                        }
                    });
                }

                // Show final list - all datastreams that pass our filters
                if (writableKeys.length > 0) {
                    const sortedWritableKeys = writableKeys.sort();
                    node.log(`[Write Data Streams] Final list of datastreams available for write selection: ${sortedWritableKeys.length} total`);
                    node.log(`[Write Data Streams] Datastream keys: ${sortedWritableKeys.join(", ")}`);
                }

                hasLoggedControllerConfig = true;
            }
        }

        // Try to log immediately, but also set up periodic check for when data becomes available
        logControllerConfig();

        // Also check on first input message (when controller data should definitely be loaded)
        let hasCheckedOnInput = false;

        // Helper to check if topic should be logged (module-level so all functions can access it)
        function shouldLogTopic(topicName) {
            if (!node.debugTopics || node.debugTopics === "") return false; // Empty = no logging
            const prefixes = node.debugTopics
                .split(",")
                .map((p) => p.trim())
                .filter((p) => p);
            if (prefixes.length === 0) return false; // No valid prefixes = no logging
            return prefixes.some((prefix) => topicName && topicName.startsWith(prefix));
        }

        // Validation constants
        const invalidValues = ["", null, undefined];
        const outputModeValid = ["all", "change"];
        const payloadTypeValid = ["static", "dynamic"];
        const channelTypeValid = ["ai", "ao", "di", "do", "supplement"];
        const discretePayloadValid = [0, 1];

        const rows = node.mappings.length || 0;
        const outputMode = node.outputMode;
        const payloadType = node.payloadType;

        // Loop detection: track conflicting keys and set flow context for gating
        const loopConflicts = new Set();

        function detectFeedbackLoops() {
            loopConflicts.clear();
            const hasAnyGateLoop = (node.mappings || []).some((m) => m && m.gateLoop === true);
            if (!hasAnyGateLoop) {
                // No gate-loop mappings configured => no need for expensive cross-flow scan.
                return;
            }

            const writeKeys = new Set();
            node.mappings.forEach((mapping) => {
                const key = mapping.keyNameSelect || mapping.keyNameManual;
                if (key) writeKeys.add(key);
            });

            // Find read nodes in ANY flow (cross-tab detection via link nodes)
            RED.nodes.eachNode((otherNode) => {
                if (otherNode.type === "uniflex-read-data-streams") {
                    const readMappings = otherNode.mappings || [];

                    readMappings.forEach((mapping) => {
                        const key = mapping.keyNameSelect || mapping.keyNameManual;
                        if (key) {
                            if (writeKeys.has(key)) {
                                loopConflicts.add(key);
                            }
                        }
                    });
                }
            });

            if (loopConflicts.size > 0) {
                const msg = `[Loop Detection] ⚠️ POTENTIAL FEEDBACK LOOP for keys: [${Array.from(loopConflicts).join(
                    ", "
                )}]. This compares topics only, not wiring. If nodes are connected, enable "Gate loop" checkbox to prevent rapid updates.`;
                node.warn(msg);
            }
        }

        // Run loop detection on startup
        detectFeedbackLoops();

        // Function to process batched messages
        function processBatchedMessages() {
            if (messageBatch.length === 0) return;

            const batch = messageBatch.slice(); // Copy array
            messageBatch = [];
            batchTimeout = null;

            // Process all messages in the batch together
            processMessagesBatch(batch);
        }

        // Function to process a batch of messages
        function processMessagesBatch(messages) {
            // Log controller config on first input message (when data becomes available)
            if (!hasCheckedOnInput) {
                hasCheckedOnInput = true;
                logControllerConfig();
            }

            // Basic validation
            if (!outputModeValid.includes(outputMode)) {
                node.error(`Output mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${outputMode}` });
                return;
            }

            if (!payloadTypeValid.includes(payloadType)) {
                node.error(`Payload type must be one of: ${payloadTypeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid payload type: ${payloadType}` });
                return;
            }

            // Initialize global context to get and set values
            const outputContextKey = `${node.controller.uniqueId}_output_states`;
            const globalContext = node.context().global;

            // Due to Promises, set default status before processing the data
            node.status({
                fill: "grey",
                shape: "dot",
                text: `Send 0 of ${rows} keys`
            });

            // Helper to check if topic should be logged (moved to module level so sendSetupValue can access it)

            // Collect all matching mappings from all messages in the batch
            const batchWrites = [];

            function getRowEntriesForMessage(msg) {
                if (payloadType === "static" && !msg.hasOwnProperty("topic")) {
                    return node.mappings.map((row, i) => ({ row, index: i }));
                }
                const seen = new Map();
                if (msg.hasOwnProperty("topic")) {
                    const topic = String(msg.topic || "").trim();
                    const list = rowsByTopic[topic] || [];
                    list.forEach((entry) => seen.set(entry.index, entry));
                } else {
                    Object.keys(rowsByTopic).forEach((topic) => {
                        if (Object.prototype.hasOwnProperty.call(msg, topic)) {
                            rowsByTopic[topic].forEach((entry) => seen.set(entry.index, entry));
                        }
                    });
                }
                return Array.from(seen.values());
            }

            function processWriteMapping(row, i, msg) {
                const svcKey = row.keyNameSelect || row.keyNameManual;
                const channelType = row.channelType;
                const topic = row.topic;
                const index = parseInt(row.index);
                let coefficient = parseFloat(row.coefficient) || 1;
                let payload;

                // Input message or row-specific validation
                if (!svcKey) {
                    return; // Skip to the next row
                }

                if (invalidValues.includes(topic)) {
                    return;
                }

                if (!channelTypeValid.includes(channelType)) {
                    return;
                }

                if (invalidValues.includes(index) || isNaN(index) || index < 1) {
                    return;
                }

                if (channelType.startsWith("a") && (invalidValues.includes(coefficient) || isNaN(coefficient))) {
                    return;
                }

                // Execute write operation only on topics specified in the msg object
                // Incoming message format: {"topic": topic, "payload": value} or {"topic1": value1, "topic2": value2, ...}
                if (payloadType === "dynamic") {
                    if (msg.hasOwnProperty("topic") && msg.topic !== topic) {
                        // Topic doesn't match this mapping - normal for multi-topic messages, don't log
                        return;
                    }

                    if (!msg.hasOwnProperty("topic") && !msg.hasOwnProperty(topic)) {
                        // No topic property and topic not in message - skip silently
                        return;
                    }

                    payload = msg.hasOwnProperty("payload") ? parseFloat(msg.payload) : parseFloat(msg[topic]);

                    // Debug: log when we find a matching topic
                    if (shouldLogTopic(topic) || topic === "HSETV.1" || topic === "HREQV.1") {
                        node.debug(`[Batching] Matched message topic=${msg.topic} to mapping topic=${topic}, svcKey=${svcKey}.${index}, payload=${payload}`);
                    }

                    // Log when we're processing a matching topic (only if it matches the filter)
                    if ((msg.topic === topic || msg.hasOwnProperty(topic)) && shouldLogTopic(topic)) {
                        node.debug(`[${svcKey}.${index}] Processing ${topic} -> ${svcKey}.${index} (payload=${payload}, payloadType=dynamic)`);
                    }
                }

                // Incoming message format: {"topic": topic} or {"topic1": true, "topic2": false, ...} or none, in which case every topic will be written.
                if (payloadType === "static") {
                    if (msg.hasOwnProperty("topic") && msg.topic !== topic) {
                        // Topic doesn't match this mapping - normal for multi-topic messages, don't log
                        return;
                    }

                    if (msg.hasOwnProperty(topic) && msg[topic] !== true) {
                        // Value is not true, skip silently
                        return;
                    }

                    payload = parseFloat(row.payload);

                    // Log when processing static payload (only if it matches the filter)
                    if (shouldLogTopic(topic)) {
                        node.debug(`[${svcKey}.${index}] Processing ${topic} -> ${svcKey}.${index} (payload=${payload} from config, payloadType=static)`);
                    }
                }

                if (invalidValues.includes(payload) || (payload !== null && typeof payload !== "string" && isNaN(payload))) {
                    return;
                }

                if (channelType.startsWith("d")) {
                    if (payload === null || payload === undefined) {
                        // null -> UNKN in io layer via /setup JSON null
                    } else if (typeof payload === "string" && payload.toUpperCase() === "UNKN") {
                        // legacy string sentinel; prefer null from NR
                    } else {
                        // For discrete channels, normalize any numeric payload to 0/1.
                        // This allows calendar "value" style payloads (e.g. 4.5 kWh) to drive ON/OFF control topics.
                        if (!discretePayloadValid.includes(payload)) {
                            const warnKey = topic || `${svcKey}.${index}`;
                            const now = Date.now();
                            const lastWarn = discreteCoerceWarnTsByTopic[warnKey] || 0;
                            if (now - lastWarn > 60000) {
                                discreteCoerceWarnTsByTopic[warnKey] = now;
                                node.warn(`[write-data-streams] Non-binary payload ${payload} for discrete ${warnKey}; coercing to ${payload > 0 ? 1 : 0}`);
                            }
                        }
                        payload = payload > 0 ? 1 : 0;
                    }
                }

                // Apply coefficient for input type if necessary
                if (channelType.startsWith("a")) {
                    coefficient = formatCoefficient(node, row);
                    payload = parseInt(payload * coefficient); // Due to UniSCADA limitations, we need to send the integer value
                }

                // Do not send output if the value hasn't changed
                // PS. In addition to checking the node's previous value, we also check the latest value saved to global context
                if (outputMode === "change" && previousValues[i] !== undefined && previousValues[i].payload === payload) {
                    const outputContext = globalContext.get(outputContextKey);
                    const outputContextValues = outputContext?.[svcKey]?.values || [];
                    const outputContextValue = outputContextValues?.[index - 1] ?? null;

                    if (outputContextValue === null) {
                        if (shouldLogTopic(topic)) {
                            node.debug(`[${svcKey}.${index}] Skipping: outputMode=change, previousValue=${previousValues[i].payload}, but context value is null`);
                        }
                        return;
                    }

                    if (outputContextValue !== null && outputContextValue === payload) {
                        if (shouldLogTopic(topic)) {
                            node.debug(`[${svcKey}.${index}] Skipping: value unchanged (${payload}) - previous=${previousValues[i].payload}, context=${outputContextValue}`);
                        }
                        return;
                    }
                }

                // Skip if a request is already in progress for this row
                if (requestInProgress[i]) {
                    if (shouldLogTopic(topic)) {
                        node.debug(`[${svcKey}.${index}] Skipping: request already in progress for row ${i + 1}`);
                    }
                    return;
                }

                // Check if this write is already in the batch (same key.member)
                const existingWriteIndex = batchWrites.findIndex((w) => w.svcKey === svcKey && w.index === index);
                if (existingWriteIndex >= 0) {
                    // Update existing write (later message takes precedence)
                    batchWrites[existingWriteIndex] = {
                        rowIndex: i,
                        svcKey: svcKey,
                        index: index,
                        channelType: channelType,
                        payload: payload,
                        topic: topic,
                        forced: !!msg.forced
                    };
                } else {
                    // Add new write to batch
                    batchWrites.push({
                        rowIndex: i,
                        svcKey: svcKey,
                        index: index,
                        channelType: channelType,
                        payload: payload,
                        topic: topic,
                        forced: !!msg.forced
                    });
                }
            }

            // Process each message in the batch
            messages.forEach((msg) => {
                // Check if message has an array payload - send directly to /setup
                if (msg.hasOwnProperty("topic") && Array.isArray(msg.payload)) {
                    handleArrayPayload(msg);
                    return;
                }

                const entries = getRowEntriesForMessage(msg);
                entries.forEach(({ row, index: i }) => processWriteMapping(row, i, msg));
            });

            // Forced writes must not share a POST with normal writes: /setup forced
            // is a top-level flag and would also force-write CTA set1 in the same batch.
            const normalWrites = batchWrites.filter((w) => !w.forced);
            const forceWrites = batchWrites.filter((w) => w.forced);

            function sendWriteBatch(writes, forced) {
                if (writes.length === 0) {
                    return;
                }
                // Build batched POST request payload
                const postData = {
                    localhost: {}
                };
                if (forced) {
                    postData.forced = true;
                }

                const batchParameters = [];

                writes.forEach((write) => {
                    const { svcKey, index, channelType, payload, topic, rowIndex } = write;

                    // Add to POST payload
                    postData.localhost[`${svcKey}.${index}`] = {
                        v: payload,
                        type: channelType
                    };

                    // Track parameters for logging
                    batchParameters.push({
                        topic: topic,
                        name: svcKey,
                        index: index,
                        type: channelType,
                        payload: payload,
                        rowIndex: rowIndex
                    });

                    // Mark as in progress
                    requestInProgress[rowIndex] = true;
                });

                if (measureDelay) lastSendTs = Date.now();

                // Log batched send (only if debugTopics is set and at least one topic matches)
                const shouldLogBatch = batchParameters.some((p) => shouldLogTopic(p.topic));
                if (shouldLogBatch) {
                    const topicsList = batchParameters.map((p) => p.topic).join(", ");
                    node.warn(`[Batching] Sending ${batchParameters.length} writes: ${topicsList}`);
                    node.warn(
                        `Querying HTTP: ${JSON.stringify({ hostname: node.controller.host, port: node.controller.httpPort, path: "/setup", method: "POST", headers: { "Content-Type": "application/json" } })} with body ${JSON.stringify(postData)}`
                    );
                }

                // Send the batched POST request to the controller
                sendSetupValue(node, postData, batchParameters)
                    .then((result) => {
                        if (result) {
                            // Update previous values and status for all writes
                            const sentKeys = [];
                            batchParameters.forEach((params) => {
                                previousValues[params.rowIndex] = { payload: params.payload, timestamp: Date.now() };
                                sentKeys.push(`${params.name}.${params.index}`);

                                // Set flow context for loop gating if enabled
                                const row = node.mappings[params.rowIndex];
                                if (row.gateLoop && loopConflicts.has(params.name)) {
                                    const flowContext = node.context().flow;
                                    const gating = flowContext.get("writeGating") || {};
                                    gating[params.name] = Date.now();
                                    flowContext.set("writeGating", gating);
                                }
                            });

                            const sentValues = sentKeys.length;
                            const shownKeys = sentKeys.slice(0, 8).join(", ");
                            const suffix = sentKeys.length > 8 ? "..." : "";
                            const rawInUse = node.transport === "raw_tcp" && tcpConnected;
                            node.status({
                                fill: sentValues === 0 ? "grey" : rawInUse ? "blue" : "green",
                                shape: sentValues > 0 ? nextActivityShape() : "dot",
                                text: `Send ${sentValues} of ${rows} keys${sentValues > 0 ? `: ${shownKeys}${suffix}` : ""}`
                            });
                        }

                        // Clear in-progress flags
                        batchParameters.forEach((params) => {
                            requestInProgress[params.rowIndex] = false;
                        });

                        if (measureDelay && shouldLogBatch) {
                            const latencyMs = Date.now() - lastSendTs;
                            recordLatencySample(latencyMs);
                        }

                        // Send output for each write
                        batchParameters.forEach((params) => {
                            node.send({
                                payload: result,
                                parameters: params,
                                controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host }
                            });
                        });
                    })
                    .catch((error) => {
                        node.error(`Error sending batched setup values: ${error}`, { error });

                        // Clear in-progress flags
                        batchParameters.forEach((params) => {
                            requestInProgress[params.rowIndex] = false;
                            node.send({
                                payload: false,
                                parameters: params,
                                controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host }
                            });
                        });
                    });
            }

            sendWriteBatch(normalWrites, false);
            sendWriteBatch(forceWrites, true);
        }

        // Listen for input messages - batch them if they arrive quickly
        node.on("input", function (msg) {
            warnInvalidServicesMetadata();

            // Add message to batch
            messageBatch.push(msg);
            const currentBatchSize = messageBatch.length;

            // Only log batching activity if debugTopics is set and this topic matches
            if (shouldLogTopic(msg.topic)) {
                node.warn(
                    `[Batching] Added message to batch: topic=${msg.topic}, payload=${msg.payload}, batch size=${currentBatchSize}, existing timeout=${batchTimeout ? "yes" : "no"}`
                );
            }

            // Clear existing timeout
            if (batchTimeout) {
                clearTimeout(batchTimeout);
                if (shouldLogTopic(msg.topic)) {
                    node.warn(`[Batching] Reset timeout, waiting for more messages... (had ${currentBatchSize - 1} messages)`);
                }
            }

            // Set new timeout to process batch
            batchTimeout = setTimeout(() => {
                const finalBatchSize = messageBatch.length;
                const shouldLog = messageBatch.some((m) => shouldLogTopic(m.topic));
                if (shouldLog) {
                    node.warn(
                        `[Batching] Processing batch of ${finalBatchSize} messages after ${BATCH_DELAY_MS}ms delay. Messages: ${messageBatch.map((m) => m.topic).join(", ")}`
                    );
                }
                processBatchedMessages();
            }, BATCH_DELAY_MS);
        });

        // Method to send setup values via selected transport
        // parameters can be a single object {name, index, payload} or an array of such objects (for batching)
        function sendSetupValue(node, postData = {}, parameters = {}, retries = 3) {
            if (node.transport === "raw_tcp") {
                // Keep latest unsent values in case both transports are down.
                queueTcpLatest(postData);
                if (!tcpConnected || !tcpSocket) {
                    connectTcp();
                    node.status({ fill: "red", shape: "dot", text: `TCP down, fallback HTTP; queued=${tcpQueueByKey.size}` });
                    return sendSetupValueHttp(node, postData, parameters, retries).then((ok) => {
                        if (ok) {
                            clearQueuedFromPostDataIfUnchanged(postData);
                            scheduleTcpPostHttpProbe();
                        }
                        return ok;
                    });
                }
                try {
                    const frame = buildTcpFrame(postData);
                    tcpSocket.write(frame);
                    clearQueuedFromPostDataIfUnchanged(postData);
                    return Promise.resolve(true);
                } catch (err) {
                    scheduleTcpReconnect();
                    node.status({ fill: "red", shape: "dot", text: "TCP write failed, fallback HTTP" });
                    return sendSetupValueHttp(node, postData, parameters, retries).then((ok) => {
                        if (ok) {
                            clearQueuedFromPostDataIfUnchanged(postData);
                            scheduleTcpPostHttpProbe();
                        }
                        return ok;
                    });
                }
            }

            return sendSetupValueHttp(node, postData, parameters, retries);
        }

        function sendSetupValueHttp(node, postData = {}, parameters = {}, retries = 3) {
            // Handle both single parameter object and array of parameters
            const isBatched = Array.isArray(parameters);
            const firstParam = isBatched ? parameters[0] : parameters;
            const { name: svcKey, index, payload } = firstParam || {};

            const options = {
                hostname: node.controller.host,
                port: node.controller.httpPort,
                path: "/setup",
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                }
            };

            // Only log if not already logged (batching code logs it) and if debugTopics matches
            if (!isBatched) {
                const topic = firstParam?.topic || "";
                if (shouldLogTopic(topic)) {
                    node.log(`Querying HTTP: ${JSON.stringify(options)} with body ${JSON.stringify(postData)}`);
                }
            }

            return new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    let data = "";

                    res.on("data", (chunk) => {
                        data += chunk;
                    });

                    res.on("end", () => {
                        try {
                            const topic = firstParam?.topic || "";
                            if (shouldLogTopic(topic)) {
                                node.log(`Received HTTP message: ${data}`);
                            }
                            const parsedData = JSON.parse(data);

                            if (parsedData?.result === true) {
                                if (node.transport !== "raw_tcp") {
                                    node.status({ fill: "green", shape: nextActivityShape(), text: `Send 1 of ${node.mappings.length} keys: ${svcKey}.${index}` });
                                }
                                resolve(true);
                            } else {
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);
                                    node.status({ fill: "yellow", shape: "dot", text: `Retrying ${svcKey}.${index}` });

                                    setTimeout(() => {
                                        resolve(sendSetupValueHttp(node, postData, parameters, retries - 1));
                                    }, 500);
                                } else {
                                    node.error(`Failed to send data ${svcKey}.${index}: ${payload}`, parameters);
                                    node.status({ fill: "red", shape: "dot", text: `Failed ${svcKey}.${index}` });

                                    resolve(false);
                                }
                            }
                        } catch (error) {
                            node.status({ fill: "red", shape: "dot", text: "Failed to parse HTTP response" });

                            // Retry if necessary
                            if (retries > 0) {
                                node.warn(`Retrying... (${retries} attempts left)`);

                                setTimeout(() => {
                                    resolve(sendSetupValueHttp(node, postData, parameters, retries - 1));
                                }, 500);
                            } else {
                                node.error(`Failed to parse HTTP response: ${error}`, { error });
                                reject(error);
                            }
                        }
                    });
                });

                req.on("error", (error) => {
                    node.status({ fill: "red", shape: "dot", text: "HTTP request error" });

                    // Retry if necessary
                    if (retries > 0) {
                        node.warn(`Retrying... (${retries} attempts left)`);

                        setTimeout(() => {
                            resolve(sendSetupValueHttp(node, postData, parameters, retries - 1));
                        }, 500);
                    } else {
                        node.error(`HTTP request error: ${error}`, { error });
                        reject(error);
                    }
                });

                // Write data to request body
                req.write(JSON.stringify(postData));
                req.end();
            });
        }

        // Return the coefficient for the specified row, or default to 1 if not found
        // Manual entries use only row.coefficient, not controller's conv_coef
        function formatCoefficient(node, row) {
            const services = node.controller?.services || {};
            const keyName = row.keyNameSelect || row.keyNameManual;

            let coef = row.coefficient;

            // Only use controller's conv_coef for non-manual entries
            if (!row.manual && keyName && services[keyName]) {
                coef = services[keyName]?.conv_coef || coef;
            }

            if (invalidValues.includes(coef)) {
                coef = 1;
            }

            return parseFloat(coef);
        }

        function normalizeDiscreteMemberValue(rawValue, topic, memberIndex) {
            if (rawValue === null || rawValue === undefined) {
                return null;
            }
            if (typeof rawValue === "string" && rawValue.toUpperCase() === "UNKN") {
                return "UNKN";
            }
            const numericValue = parseFloat(rawValue);
            if (!Number.isFinite(numericValue)) {
                return rawValue;
            }
            if (!discretePayloadValid.includes(numericValue)) {
                const warnKey = `${topic}.${memberIndex}`;
                const now = Date.now();
                const lastWarn = discreteCoerceWarnTsByTopic[warnKey] || 0;
                if (now - lastWarn > 60000) {
                    discreteCoerceWarnTsByTopic[warnKey] = now;
                    node.warn(`[write-data-streams] Non-binary payload ${numericValue} for discrete ${warnKey}; coercing to ${numericValue > 0 ? 1 : 0}`);
                }
            }
            return numericValue > 0 ? 1 : 0;
        }

        // Handle array payload - send directly to /setup endpoint
        function handleArrayPayload(msg) {
            const topic = msg.topic;
            const arrayPayload = msg.payload;

            // Determine channel type from configured mappings
            // Look for any row that matches this datastream name
            let channelType = null;
            for (const row of node.mappings) {
                const svcKey = row.keyNameSelect || row.keyNameManual;
                if (svcKey === topic) {
                    channelType = row.channelType;
                    break;
                }
            }

            if (!channelType) {
                node.error(`No configuration found for array topic: ${topic}`);
                node.status({ fill: "red", shape: "dot", text: `No config for ${topic}` });
                return;
            }

            if (!channelTypeValid.includes(channelType)) {
                node.error(`Invalid channel type: ${channelType}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid channel type: ${channelType}` });
                return;
            }

            // Normalize/scale array payload using the same rules as scalar writes:
            // - analogue (ai/ao): apply coefficient and convert to integer
            // - discrete (di/do): normalize to 0/1
            const normalizedArrayPayload = Array.isArray(arrayPayload)
                ? arrayPayload.map((rawValue, idx0) => {
                      const memberIndex = idx0 + 1;
                      const numericValue = parseFloat(rawValue);

                      // Keep non-numeric values unchanged; backend validation will reject if unsupported.
                      if (!Number.isFinite(numericValue)) return rawValue;

                      if (channelType.startsWith("a")) {
                          const rowForMember = node.mappings.find((m) => {
                              const key = m.keyNameSelect || m.keyNameManual;
                              const idx = Number.isInteger(m.index) ? m.index : parseInt(m.index, 10);
                              return key === topic && idx === memberIndex;
                          });
                          const coef = rowForMember ? formatCoefficient(node, rowForMember) : 1;
                          return parseInt(numericValue * coef);
                      }

                      if (channelType.startsWith("d")) {
                          return normalizeDiscreteMemberValue(rawValue, topic, memberIndex);
                      }

                      return numericValue;
                  })
                : arrayPayload;

            // Build the POST request payload for array format
            const postData = {
                localhost: {
                    [topic]: {
                        v: normalizedArrayPayload,
                        type: channelType
                    }
                }
            };

            // Check if any mapping for this topic has forceWrite enabled
            const hasForceWrite = node.mappings.some((m) => {
                const key = m.keyNameSelect || m.keyNameManual;
                return key === topic && m.forceWrite;
            });

            if (hasForceWrite || msg.forced) {
                postData.forced = true;
            }

            const parameters = {
                topic,
                name: topic,
                type: channelType,
                payload: normalizedArrayPayload
            };

            if (measureDelay) lastSendTs = Date.now();

            // Special warning for THFW array writes
            if (topic === "THFW") {
                node.warn(
                    `!!! ARRAY WRITE TO THFW (includes THFW.1 which should be READ-ONLY) !!! msg.topic=${msg.topic || "none"}, array payload=${JSON.stringify(normalizedArrayPayload)}`
                );
            }

            // Send the POST request to the controller
            sendSetupValue(node, postData, parameters)
                .then((result) => {
                    if (result) {
                        // Set flow context for loop gating if topic is in conflicts
                        // For array payloads, gate if any mapping for this key has gateLoop enabled
                        const hasGating = node.mappings.some((m) => {
                            const key = m.keyNameSelect || m.keyNameManual;
                            return key === topic && m.gateLoop;
                        });

                        if (hasGating && loopConflicts.has(topic)) {
                            const flowContext = node.context().flow;
                            const gating = flowContext.get("writeGating") || {};
                            gating[topic] = Date.now();
                            flowContext.set("writeGating", gating);
                        }

                        node.status({
                            fill: node.transport === "raw_tcp" && tcpConnected ? "blue" : "green",
                            shape: nextActivityShape(),
                            text: `Send 1 of ${node.mappings.length} keys: ${topic}`
                        });
                    }

                    if (measureDelay) {
                        const latencyMs = Date.now() - lastSendTs;
                        recordLatencySample(latencyMs);
                    }

                    node.send({ payload: result, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                })
                .catch((error) => {
                    node.error(`Error sending array value: ${error}`, { error });
                    node.send({ payload: false, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                });
        }

        node.on("close", function () {
            if (batchTimeout) {
                clearTimeout(batchTimeout);
                batchTimeout = null;
            }
            if (tcpReconnectTimer) {
                clearTimeout(tcpReconnectTimer);
                tcpReconnectTimer = null;
            }
            if (tcpPostHttpProbeTimer) {
                clearTimeout(tcpPostHttpProbeTimer);
                tcpPostHttpProbeTimer = null;
            }
            if (tcpSocket) {
                try {
                    tcpSocket.destroy();
                } catch (e) {
                    // ignore
                }
                tcpSocket = null;
            }
            tcpConnected = false;
            tcpConnecting = false;
            tcpQueueByKey.clear();
        });
    }

    RED.nodes.registerType("uniflex-write-data-streams", WriteDataStreamsNode);
};
