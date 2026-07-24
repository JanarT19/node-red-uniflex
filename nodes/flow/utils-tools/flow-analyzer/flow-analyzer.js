const ts = require("../../core/lib/timestamp.js");
/**
 * Flow Analyzer Node
 * Deep analysis of Node-RED flows to detect loops, issues, and optimization opportunities
 */

module.exports = function (RED) {
    "use strict";

    function FlowAnalyzerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.autoRunOnDeploy = config.autoRunOnDeploy !== false; // Default true
        node.showInStatus = config.showInStatus !== false; // Default true
        node.analyzeAllFlows = config.analyzeAllFlows !== false; // Default true

        // Status display
        function setStatus(text, shape, fill) {
            if (node.showInStatus) {
                node.status({ fill: fill, shape: shape, text: text });
            }
        }

        setStatus("Ready", "dot", "grey");

        /**
         * Main analysis function
         */
        function analyzeFlows() {
            const startTime = Date.now();
            const results = {
                timestamp: new Date().toISOString(),
                summary: {
                    totalNodes: 0,
                    totalFlows: 0,
                    issues: 0,
                    warnings: 0,
                    info: 0
                },
                loops: [],
                topicConflicts: [],
                disconnectedNodes: [],
                linkChains: [],
                performanceRisks: [],
                details: []
            };

            try {
                // Build flow map
                const flowMap = buildFlowMap();
                results.summary.totalNodes = flowMap._totalNodeCount || 0;
                results.summary.totalFlows = Object.keys(flowMap).length;

                // Run all checks
                detectFeedbackLoops(flowMap, results);
                detectTopicConflicts(flowMap, results);
                detectDisconnectedNodes(flowMap, results);
                analyzeLinkChains(flowMap, results);
                detectPerformanceRisks(flowMap, results);

                // Calculate summary
                results.summary.issues = results.loops.length + results.topicConflicts.filter((c) => c.severity === "error").length;
                results.summary.warnings =
                    results.topicConflicts.filter((c) => c.severity === "warning").length + results.disconnectedNodes.length + results.performanceRisks.length;
                results.summary.info = results.linkChains.length;

                const elapsed = Date.now() - startTime;
                results.analysisTime = `${elapsed}ms`;

                // Update status
                if (results.summary.issues > 0) {
                    setStatus(`${results.summary.issues} issues found`, "dot", "red");
                } else if (results.summary.warnings > 0) {
                    setStatus(`${results.summary.warnings} warnings`, "dot", "yellow");
                } else {
                    setStatus(`Clean (${elapsed}ms)`, "dot", "green");
                }

                // Log summary
                node.log(`Flow analysis complete: ${results.summary.issues} issues, ${results.summary.warnings} warnings (${elapsed}ms)`);

                // Print detailed summary report to log
                printSummaryReport(results);

                // Send results
                node.send({
                    payload: results,
                    topic: "flow-analysis"
                });

                return results;
            } catch (err) {
                node.error(`Flow analysis failed: ${err.message}`, err);
                setStatus("Analysis failed", "dot", "red");
                return null;
            }
        }

        /**
         * Build a map of all flows and nodes
         */
        function buildFlowMap() {
            const flowMap = {};
            let totalNodeCount = 0;

            RED.nodes.eachNode((n) => {
                totalNodeCount++;
                if (!flowMap[n.z]) {
                    flowMap[n.z] = {
                        id: n.z,
                        nodes: [],
                        writeNodes: [],
                        readNodes: [],
                        linkOutNodes: [],
                        linkInNodes: []
                    };
                }

                flowMap[n.z].nodes.push(n);

                // Categorize special nodes
                if (n.type === "uniflex-write-data-streams") {
                    flowMap[n.z].writeNodes.push(n);
                } else if (n.type === "uniflex-read-data-streams") {
                    flowMap[n.z].readNodes.push(n);
                } else if (n.type === "link out") {
                    flowMap[n.z].linkOutNodes.push(n);
                } else if (n.type === "link in") {
                    flowMap[n.z].linkInNodes.push(n);
                }
            });

            // Count total nodes
            Object.keys(flowMap).forEach((flowId) => {
                const flow = flowMap[flowId];
                flow.nodeCount = flow.nodes.length;
            });

            // Store total count using a non-enumerable property to avoid iteration issues
            Object.defineProperty(flowMap, "_totalNodeCount", {
                value: totalNodeCount,
                enumerable: false,
                writable: false
            });

            return flowMap;
        }

        /**
         * Detect actual feedback loops by following wires
         */
        function detectFeedbackLoops(flowMap, results) {
            const visited = new Set();
            const recStack = new Set();
            const paths = new Map();

            // Check each write node
            Object.values(flowMap).forEach((flow) => {
                flow.writeNodes.forEach((writeNode) => {
                    visited.clear();
                    recStack.clear();
                    paths.clear();

                    const loop = detectLoopFromNode(writeNode, writeNode, [], flowMap, visited, recStack);
                    if (loop) {
                        results.loops.push({
                            type: "feedback-loop",
                            severity: "error",
                            path: loop.path,
                            pathIds: loop.pathIds,
                            description: `Feedback loop detected: ${loop.path.join(" → ")}`,
                            startNode: writeNode.id,
                            startNodeName: writeNode.name || writeNode.type
                        });
                    }
                });
            });
        }

        /**
         * Recursive loop detection following wires
         */
        function detectLoopFromNode(currentNode, targetNode, path, flowMap, visited, recStack) {
            if (!currentNode) return null;

            const nodeId = currentNode.id;
            const nodeName = currentNode.name || currentNode.type;

            // Found a loop back to target
            if (path.length > 0 && nodeId === targetNode.id) {
                return {
                    path: [...path, nodeName],
                    pathIds: [...path.map((p) => p.id), nodeId]
                };
            }

            // Already in recursion stack = loop detected
            if (recStack.has(nodeId)) {
                return null;
            }

            // Mark as visiting
            recStack.add(nodeId);
            path.push({ name: nodeName, id: nodeId });

            // Follow wires
            if (currentNode.wires && Array.isArray(currentNode.wires)) {
                for (const wireArray of currentNode.wires) {
                    if (Array.isArray(wireArray)) {
                        for (const targetId of wireArray) {
                            const nextNode = RED.nodes.getNode(targetId);
                            if (nextNode) {
                                // Handle link-out nodes specially
                                if (nextNode.type === "link out") {
                                    const linkedNodes = findLinkedInNodes(nextNode, flowMap);
                                    for (const linkedNode of linkedNodes) {
                                        const result = detectLoopFromNode(linkedNode, targetNode, [...path], flowMap, visited, recStack);
                                        if (result) return result;
                                    }
                                } else {
                                    const result = detectLoopFromNode(nextNode, targetNode, [...path], flowMap, visited, recStack);
                                    if (result) return result;
                                }
                            }
                        }
                    }
                }
            }

            // Unmark from recursion stack
            recStack.delete(nodeId);
            path.pop();

            return null;
        }

        /**
         * Find link-in nodes connected to a link-out node
         */
        function findLinkedInNodes(linkOutNode, flowMap) {
            const linkedNodes = [];
            const linkOutLinks = linkOutNode.links || [];

            Object.values(flowMap).forEach((flow) => {
                flow.linkInNodes.forEach((linkInNode) => {
                    if (linkOutLinks.includes(linkInNode.id)) {
                        linkedNodes.push(linkInNode);
                    }
                });
            });

            return linkedNodes;
        }

        /**
         * Detect topic conflicts between read/write nodes
         */
        function detectTopicConflicts(flowMap, results) {
            const writeTopics = new Map(); // topic -> [nodes]
            const readTopics = new Map(); // topic -> [nodes]

            // Collect all write topics
            Object.values(flowMap).forEach((flow) => {
                flow.writeNodes.forEach((writeNode) => {
                    const topics = extractWriteTopics(writeNode);
                    // Deduplicate topics from same node (e.g., HV2W.1, HV2W.2 both map to HV2W)
                    const uniqueTopics = [...new Set(topics)];
                    uniqueTopics.forEach((topic) => {
                        if (!writeTopics.has(topic)) {
                            writeTopics.set(topic, []);
                        }
                        // Check if this node is already in the list for this topic
                        const existing = writeTopics.get(topic).find((n) => n.node.id === writeNode.id);
                        if (!existing) {
                            writeTopics.get(topic).push({
                                node: writeNode,
                                flowId: flow.id
                            });
                        }
                    });
                });

                flow.readNodes.forEach((readNode) => {
                    const topics = extractReadTopics(readNode);
                    // Deduplicate topics from same node
                    const uniqueTopics = [...new Set(topics)];
                    uniqueTopics.forEach((topic) => {
                        if (!readTopics.has(topic)) {
                            readTopics.set(topic, []);
                        }
                        // Check if this node is already in the list for this topic
                        const existing = readTopics.get(topic).find((n) => n.node.id === readNode.id);
                        if (!existing) {
                            readTopics.get(topic).push({
                                node: readNode,
                                flowId: flow.id
                            });
                        }
                    });
                });
            });

            // Find overlaps
            writeTopics.forEach((writers, topic) => {
                if (readTopics.has(topic)) {
                    const readers = readTopics.get(topic);

                    // Check if there's actual wiring between them
                    let hasWiring = false;
                    for (const writer of writers) {
                        for (const reader of readers) {
                            if (isConnected(writer.node, reader.node, flowMap)) {
                                hasWiring = true;
                                break;
                            }
                        }
                        if (hasWiring) break;
                    }

                    results.topicConflicts.push({
                        topic: topic,
                        severity: hasWiring ? "error" : "warning",
                        writers: writers.map((w) => ({ id: w.node.id, name: w.node.name || w.node.type, flow: w.flowId })),
                        readers: readers.map((r) => ({ id: r.node.id, name: r.node.name || r.node.type, flow: r.flowId })),
                        description: hasWiring
                            ? `CONFIRMED LOOP: Topic "${topic}" has ${writers.length} writer(s) and ${readers.length} reader(s) with actual wiring connection`
                            : `Topic "${topic}" has ${writers.length} writer(s) and ${readers.length} reader(s) (no direct wiring detected)`,
                        hasWiring: hasWiring
                    });
                }

                // Multiple writers to same topic
                if (writers.length > 1) {
                    results.topicConflicts.push({
                        topic: topic,
                        severity: "warning",
                        writers: writers.map((w) => ({ id: w.node.id, name: w.node.name || w.node.type, flow: w.flowId })),
                        description: `Multiple nodes (${writers.length}) writing to topic "${topic}" - potential conflict`
                    });
                }
            });
        }

        /**
         * Check if two nodes are connected via wiring
         */
        function isConnected(sourceNode, targetNode, flowMap, visited = new Set()) {
            if (!sourceNode || !targetNode) return false;
            if (sourceNode.id === targetNode.id) return true;
            if (visited.has(sourceNode.id)) return false;

            visited.add(sourceNode.id);

            // Follow wires
            if (sourceNode.wires && Array.isArray(sourceNode.wires)) {
                for (const wireArray of sourceNode.wires) {
                    if (Array.isArray(wireArray)) {
                        for (const targetId of wireArray) {
                            if (targetId === targetNode.id) return true;

                            const nextNode = RED.nodes.getNode(targetId);
                            if (nextNode) {
                                // Handle link-out nodes
                                if (nextNode.type === "link out") {
                                    const linkedNodes = findLinkedInNodes(nextNode, flowMap);
                                    for (const linkedNode of linkedNodes) {
                                        if (isConnected(linkedNode, targetNode, flowMap, visited)) {
                                            return true;
                                        }
                                    }
                                } else {
                                    if (isConnected(nextNode, targetNode, flowMap, visited)) {
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            return false;
        }

        /**
         * Extract topics with member indices from write node config
         */
        function extractWriteTopics(writeNode) {
            const topics = [];
            if (writeNode.mappings && Array.isArray(writeNode.mappings)) {
                writeNode.mappings.forEach((mapping) => {
                    const key = mapping.keyNameSelect || mapping.keyNameManual;
                    const member = mapping.memberIndex || mapping.memberIndexManual || "1";
                    if (key) {
                        // Include member index for accurate conflict detection
                        topics.push(`${key}.${member}`);
                    }
                });
            }
            return topics;
        }

        /**
         * Extract topics with member indices from read node config
         */
        function extractReadTopics(readNode) {
            const topics = [];
            if (readNode.mappings && Array.isArray(readNode.mappings)) {
                readNode.mappings.forEach((mapping) => {
                    const key = mapping.keyNameSelect || mapping.keyNameManual;
                    const member = mapping.memberIndex || mapping.memberIndexManual || "1";
                    if (key) {
                        // Include member index for accurate conflict detection
                        topics.push(`${key}.${member}`);
                    }
                });
            }
            return topics;
        }

        /**
         * Detect disconnected nodes
         */
        function detectDisconnectedNodes(flowMap, results) {
            Object.values(flowMap).forEach((flow) => {
                flow.nodes.forEach((n) => {
                    const hasInputs = hasIncomingWires(n, flow);
                    const hasOutputs = n.wires && n.wires.length > 0 && n.wires.some((w) => w && w.length > 0);

                    // Skip certain node types that don't need connections
                    const skipTypes = [
                        "comment",
                        "inject",
                        "debug",
                        "link in",
                        "link out",
                        "catch",
                        "status",
                        "tab",
                        "group",
                        "subflow", // Structural nodes
                        "uniflex-controller",
                        "ui-base",
                        "ui-page",
                        "ui-group",
                        "ui-theme", // Config nodes
                        "mqtt-broker",
                        "http request" // Other config-like nodes
                    ];
                    if (skipTypes.includes(n.type)) return;

                    if (!hasInputs && !hasOutputs) {
                        results.disconnectedNodes.push({
                            id: n.id,
                            name: n.name || n.type,
                            type: n.type,
                            flow: flow.id,
                            description: `Node "${n.name || n.type}" has no connections`
                        });
                    }
                });
            });
        }

        /**
         * Check if node has incoming wires
         */
        function hasIncomingWires(targetNode, flow) {
            return flow.nodes.some((n) => {
                if (!n.wires) return false;
                return n.wires.some((wireArray) => {
                    return wireArray && wireArray.includes(targetNode.id);
                });
            });
        }

        /**
         * Print a formatted summary report to the log
         */
        function printSummaryReport(results) {
            const lines = [];
            lines.push("");
            lines.push("╔══════════════════════════════════════════════════════════════════════╗");
            lines.push("║              FLOW ANALYSIS SUMMARY REPORT                            ║");
            lines.push("╚══════════════════════════════════════════════════════════════════════╝");
            lines.push("");

            // Summary stats
            lines.push(`📊 Overview:`);
            lines.push(`   Total Nodes: ${results.summary.totalNodes}`);
            lines.push(`   Total Flows: ${results.summary.totalFlows}`);
            lines.push(`   Analysis Time: ${results.analysisTime}`);
            lines.push("");

            // Issues (red)
            if (results.summary.issues > 0) {
                lines.push(`🔴 ISSUES: ${results.summary.issues}`);
                results.loops.forEach((loop, i) => {
                    lines.push(`   ${i + 1}. Feedback Loop: ${loop.path.join(" → ")}`);
                });
                results.topicConflicts
                    .filter((c) => c.severity === "error")
                    .forEach((conf, i) => {
                        if (conf.hasWiring) {
                            lines.push(`   ${results.loops.length + i + 1}. CONFIRMED LOOP: "${conf.topic}" has wiring connection`);
                            lines.push(`      Writers: ${conf.writers.map((w) => w.name).join(", ")}`);
                            lines.push(`      Readers: ${conf.readers.map((r) => r.name).join(", ")}`);
                        }
                    });
                lines.push("");
            } else {
                lines.push(`✅ ISSUES: None`);
                lines.push("");
            }

            // Warnings (yellow)
            const topicWarnings = results.topicConflicts.filter((c) => c.severity === "warning" && c.readers);
            const multiWriters = results.topicConflicts.filter((c) => !c.readers && c.writers.length > 1);

            if (results.summary.warnings > 0) {
                lines.push(`⚠️  WARNINGS: ${results.summary.warnings}`);

                // Topic conflicts (no wiring)
                if (topicWarnings.length > 0) {
                    lines.push(`   📡 Topic Overlaps (no direct wiring):`);
                    topicWarnings.forEach((conf) => {
                        lines.push(`      • "${conf.topic}": ${conf.writers.length} writer(s) + ${conf.readers.length} reader(s)`);
                    });
                }

                // Multiple writers
                if (multiWriters.length > 0) {
                    lines.push(`   ✍️  Multiple Writers to Same Topic+Member:`);
                    multiWriters.forEach((conf) => {
                        lines.push(`      • "${conf.topic}": ${conf.writers.length} writers`);
                    });
                }

                // Disconnected nodes
                if (results.disconnectedNodes.length > 0) {
                    lines.push(`   🔌 Disconnected Nodes: ${results.disconnectedNodes.length}`);
                    results.disconnectedNodes.forEach((node) => {
                        lines.push(`      • ${node.name} (${node.type})`);
                    });
                }

                // Performance risks
                if (results.performanceRisks.length > 0) {
                    lines.push(`   ⚡ Performance Risks: ${results.performanceRisks.length}`);
                    results.performanceRisks.forEach((risk) => {
                        if (risk.type === "large-flow") {
                            lines.push(`      • Large flow: ${risk.nodeCount} nodes`);
                        } else if (risk.type === "rapid-inject") {
                            lines.push(`      • Rapid inject: "${risk.node.name}" every ${risk.interval}s`);
                        }
                    });
                }

                lines.push("");
            } else {
                lines.push(`✅ WARNINGS: None`);
                lines.push("");
            }

            // Info (blue)
            if (results.summary.info > 0) {
                lines.push(`ℹ️  INFO: ${results.summary.info} link chains found`);
                lines.push(`   (Link chains = WIRED functional dependencies via link-out → link-in nodes)`);
                lines.push(`   (These are REAL data flows, not just topic name matches)`);
                const crossTabLinks = results.linkChains.filter((l) => l.crossTab);
                if (crossTabLinks.length > 0) {
                    lines.push(`   🔗 Cross-tab links: ${crossTabLinks.length} (data flowing between different tabs)`);
                }
                lines.push("");
            }

            // Recommendations
            if (results.summary.issues > 0 || results.summary.warnings > 0) {
                lines.push(`💡 Recommendations:`);
                if (results.summary.issues > 0) {
                    lines.push(`   1. Fix confirmed loops first (enable "Gate loop" or break wiring)`);
                }
                if (topicWarnings.length > 0) {
                    lines.push(`   2. Topic+Member overlaps shown are at MEMBER level (e.g., HV2W.1 vs HV2W.1)`);
                    lines.push(`      - If different members (HV2W.1 vs HV2W.2), no conflict!`);
                    lines.push(`      - Overlaps are safe if nodes aren't directly wired together`);
                }
                if (results.disconnectedNodes.length > 0) {
                    lines.push(`   3. Remove or connect disconnected nodes`);
                }
                lines.push("");
            }

            lines.push("────────────────────────────────────────────────────────────────────────");
            lines.push("");
            lines.push("ℹ️  Note: This analyzer checks WIRING structure. For TOPIC orphan detection");
            lines.push("   (topics published but not consumed, or vice versa), use flow-validator node.");
            lines.push("   Both analyzers are complementary and serve different purposes.");
            lines.push("");

            // Log all lines
            lines.forEach((line) => node.warn(line));
        }

        /**
         * Analyze link node chains
         */
        function analyzeLinkChains(flowMap, results) {
            const linkChains = new Map();

            Object.values(flowMap).forEach((flow) => {
                flow.linkOutNodes.forEach((linkOut) => {
                    const linkedIns = findLinkedInNodes(linkOut, flowMap);
                    if (linkedIns.length > 0) {
                        linkChains.set(linkOut.id, {
                            linkOut: { id: linkOut.id, name: linkOut.name, flow: flow.id },
                            linkIns: linkedIns.map((li) => ({
                                id: li.id,
                                name: li.name,
                                flow: li.z
                            })),
                            crossTab: linkedIns.some((li) => li.z !== linkOut.z)
                        });
                    }
                });
            });

            linkChains.forEach((chain, id) => {
                results.linkChains.push({
                    linkOut: chain.linkOut,
                    linkIns: chain.linkIns,
                    crossTab: chain.crossTab,
                    description: `Link "${chain.linkOut.name}" connects to ${chain.linkIns.length} link-in node(s)${chain.crossTab ? " (cross-tab)" : ""}`
                });
            });
        }

        /**
         * Detect performance risks
         */
        function detectPerformanceRisks(flowMap, results) {
            Object.values(flowMap).forEach((flow) => {
                // Too many nodes in one flow
                if (flow.nodeCount > 100) {
                    results.performanceRisks.push({
                        type: "large-flow",
                        severity: "warning",
                        flow: flow.id,
                        nodeCount: flow.nodeCount,
                        description: `Flow has ${flow.nodeCount} nodes - consider splitting for better performance`
                    });
                }

                // Check for rapid loops (inject with short interval)
                flow.nodes.forEach((n) => {
                    if (n.type === "inject" && n.repeat && parseFloat(n.repeat) < 0.5) {
                        results.performanceRisks.push({
                            type: "rapid-inject",
                            severity: "warning",
                            node: { id: n.id, name: n.name || n.type },
                            interval: n.repeat,
                            description: `Inject node "${n.name || n.type}" runs every ${n.repeat}s - may cause high CPU usage`
                        });
                    }
                });
            });
        }

        // Handle input messages (manual trigger)
        node.on("input", function (msg) {
            node.log("Manual flow analysis triggered");
            analyzeFlows();
        });

        // Auto-run on deploy (via deploy event detection)
        if (node.autoRunOnDeploy) {
            // Use a short delay to ensure all nodes are registered
            setTimeout(() => {
                node.log("Auto-running flow analysis on deploy");
                analyzeFlows();
            }, 1000);
        }

        node.on("close", function () {
            setStatus("", "dot", "grey");
        });
    }

    RED.nodes.registerType("uniflex-flow-analyzer", FlowAnalyzerNode);
};
