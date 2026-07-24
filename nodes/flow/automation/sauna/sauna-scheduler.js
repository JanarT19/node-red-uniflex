/**
 * sauna-scheduler.js
 *
 * Schedules sauna preheating events based on electricity prices.
 * Finds the cheapest hour to preheat, with a slight preference for hours
 * closer to the visiting time (to minimize cooldown).
 *
 * Triggered by inject node (handles day selection via cron).
 * Separate flow checks calendar for active events and publishes to IO.
 *
 * Uses:
 * - optimizer-utils.js for optimization algorithms
 * - sql-calendar nodes for reading prices and writing events
 */

const optimizerUtils = require("../../core/calendar/optimizer-utils");
const ts = require("../../core/lib/timestamp.js");
const fs = require("fs");

const NODE_VERSION = "2.2.0";

module.exports = function (RED) {
    function SaunaSchedulerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        node.targetTime = config.targetTime || "18:00"; // HH:MM
        node.preheatDuration = parseFloat(config.preheatDuration) || 2.0; // hours
        node.priceSeriesTitle = config.priceSeriesTitle || "elering";
        node.eventTitle = config.eventTitle || "sauna_preheat";
        node.triggerTopic = config.triggerTopic || "";
        node.calendarTopic = config.calendarTopic || config.calendarReadTopic || config.calendarWriteTopic || "sauna_calendar"; // Support old configs
        node.enableLogging = config.enableLogging !== false; // default true
        node.timeFactor = parseFloat(config.timeFactor) || 1.0; // Heat loss rate in %/h
        node.heaterPowerKw = parseFloat(config.heaterPowerKw) || 6.0; // Sauna heater nominal power
        node.heaterLogPath = (config.heaterLogPath || "").trim(); // Optional ON/OFF log file for quota checks
        node.maxPreheatPer24hSec = Math.max(0, parseInt(config.maxPreheatPer24hSec, 10) || 3600); // Default legal quota: 1h / 24h

        // State
        let pendingSchedule = null; // Stores state between calendar operations
        let pendingCreates = 0; // Track how many create events we're waiting for

        if (node.enableLogging) {
            node.log(
                `[sauna-scheduler v${NODE_VERSION}] Initialized | Target: ${node.targetTime} | Preheat: ${node.preheatDuration}h | Price: ${node.priceSeriesTitle} | Event: ${node.eventTitle}`
            );
        }

        node.status({ fill: "grey", shape: "ring", text: "idle" });

        /**
         * Parse target time (HH:MM) and return today's timestamp
         */
        function getTargetTimestamp() {
            const [hours, minutes] = node.targetTime.split(":").map(Number);
            const now = new Date();
            const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
            return Math.floor(target.getTime() / 1000);
        }

        /**
         * Calculate effective price for a single 15-minute interval
         * Accounts for heat loss: earlier preheating loses energy while waiting
         *
         * @param {Object} item - {timestamp, value} object
         * @param {number} targetTimestamp - Target sauna time (Unix seconds)
         * @returns {number} Effective price (price + heat loss penalty)
         */
        function calculateEffectivePrice(item, targetTimestamp) {
            // Each interval is 15 minutes (900 seconds)
            const intervalDuration = 900;
            const intervalEnd = item.timestamp + intervalDuration;
            const waitingHours = Math.max(0, (targetTimestamp - intervalEnd) / 3600);

            // Apply heat loss penalty: each hour of waiting increases effective price
            // timeFactor is loss rate in %/h (e.g., 0.1 = 0.1% per hour, 1.0 = 1% per hour)
            const lossMultiplier = 1 + (waitingHours * node.timeFactor) / 100;
            return item.value * lossMultiplier;
        }

        function parseLogTimestamp(ts) {
            if (!ts) return null;
            // Supports "YYYY-MM-DD HH:mm:ss" (local time).
            const d = new Date(ts.replace(" ", "T"));
            if (Number.isNaN(d.getTime())) return null;
            return Math.floor(d.getTime() / 1000);
        }

        function getRecentPreheatSecondsFromLog(nowSec) {
            if (!node.heaterLogPath) return 0;
            try {
                const raw = fs.readFileSync(node.heaterLogPath, "utf8");
                if (!raw) return 0;
                const lines = raw.split(/\r?\n/).filter(Boolean);
                const windowStart = nowSec - 86400;
                let preheatOnTs = null;
                let totalSec = 0;

                for (const line of lines) {
                    const firstComma = line.indexOf(",");
                    if (firstComma < 0) continue;
                    const secondComma = line.indexOf(",", firstComma + 1);
                    if (secondComma < 0) continue;
                    const thirdComma = line.indexOf(",", secondComma + 1);
                    const tsStr = line.substring(0, firstComma).trim();
                    const state = line.substring(firstComma + 1, secondComma).trim();
                    const reason = (thirdComma >= 0 ? line.substring(secondComma + 1, thirdComma) : line.substring(secondComma + 1)).trim();
                    const reasonLower = reason.toLowerCase();
                    const isPreheatStart = reasonLower.startsWith("preheat");
                    const ts = parseLogTimestamp(tsStr);
                    if (!Number.isFinite(ts)) continue;

                    if (state === "ON") {
                        // Count any explicit preheat mode start, including variants
                        // such as "preheat_forced".
                        if (isPreheatStart && preheatOnTs === null) preheatOnTs = ts;
                    } else if (state === "OFF") {
                        // Close an active preheat session on any OFF reason, since
                        // controllers can switch reason strings when turning OFF.
                        if (preheatOnTs !== null) {
                            const start = Math.max(preheatOnTs, windowStart);
                            const end = Math.min(ts, nowSec);
                            if (end > start) totalSec += end - start;
                            preheatOnTs = null;
                        }
                    }
                }

                if (preheatOnTs !== null) {
                    const start = Math.max(preheatOnTs, windowStart);
                    const end = nowSec;
                    if (end > start) totalSec += end - start;
                }

                return totalSec;
            } catch (err) {
                node.warn(`Preheat quota log read failed (${node.heaterLogPath}): ${err.message}`);
                return 0;
            }
        }

        function mergeConsecutiveIntervals(intervals, intervalSec) {
            const sorted = (Array.isArray(intervals) ? intervals : []).slice().sort((a, b) => a.timestamp - b.timestamp);
            if (sorted.length === 0) return [];

            const groups = [];
            let current = { start: sorted[0].timestamp, end: sorted[0].timestamp + intervalSec, count: 1 };

            for (let i = 1; i < sorted.length; i++) {
                const ts = sorted[i].timestamp;
                if (ts === current.end) {
                    current.end += intervalSec;
                    current.count += 1;
                } else {
                    groups.push(current);
                    current = { start: ts, end: ts + intervalSec, count: 1 };
                }
            }
            groups.push(current);
            return groups;
        }

        /**
         * Start the scheduling process (triggered by input)
         */
        function startScheduler() {
            const targetTimestamp = getTargetTimestamp();
            const now = Math.floor(Date.now() / 1000);
            if (now >= targetTimestamp) {
                node.status({ fill: "yellow", shape: "ring", text: "past target time today" });
                if (node.enableLogging) {
                    node.warn("Skipping scheduling: past target time today");
                }
                return;
            }
            const requestedPreheatSeconds = node.preheatDuration * 3600;
            const usedPreheatSec = getRecentPreheatSecondsFromLog(now);
            const remainingPreheatSec = Math.max(0, node.maxPreheatPer24hSec - usedPreheatSec);
            const preheatSeconds = Math.max(0, Math.min(requestedPreheatSeconds, remainingPreheatSec));
            const latestStart = targetTimestamp - preheatSeconds;

            if (node.enableLogging) {
                const targetDate = new Date(targetTimestamp * 1000);
                const latestDate = new Date(latestStart * 1000);
                node.log(
                    `Scheduling for target: ${targetDate.toLocaleTimeString()} | ` +
                        `Requested=${(requestedPreheatSeconds / 3600).toFixed(2)}h | ` +
                        `Used24h=${(usedPreheatSec / 60).toFixed(1)}min | ` +
                        `Remaining=${(remainingPreheatSec / 60).toFixed(1)}min | ` +
                        `Planned=${(preheatSeconds / 3600).toFixed(2)}h | ` +
                        `Latest start: ${latestDate.toLocaleTimeString()}`
                );
            }

            if (preheatSeconds < 900) {
                node.status({ fill: "yellow", shape: "ring", text: "preheat quota exhausted (24h)" });
                if (node.enableLogging) {
                    node.warn("Skipping scheduling: less than one 15-minute interval left in 24h preheat quota");
                }
                return;
            }

            // Store state for later steps
            pendingSchedule = {
                startTime: Date.now(),
                targetTimestamp,
                now,
                preheatSeconds,
                latestStart,
                step: "reading_prices"
            };

            node.status({ fill: "blue", shape: "dot", text: "reading prices..." });

            // Request price data from sql-calendar
            node.send({
                topic: node.calendarTopic,
                mode: "read",
                title: node.priceSeriesTitle,
                start: now,
                end: targetTimestamp
            });
        }

        /**
         * Handle price data response from sql-calendar
         */
        function handlePriceData(payload) {
            if (!pendingSchedule || pendingSchedule.step !== "reading_prices") {
                node.warn("Received price data but no pending schedule");
                return;
            }

            try {
                // Extract data array from sql-calendar response
                let priceData = [];
                if (Array.isArray(payload)) {
                    priceData = payload;
                } else if (payload && Array.isArray(payload.data)) {
                    priceData = payload.data;
                } else if (payload && payload.success === false) {
                    throw new Error(payload.error || "Failed to read price data");
                } else {
                    throw new Error("Invalid price data format");
                }

                if (priceData.length === 0) {
                    throw new Error("No price data available");
                }

                if (node.enableLogging) {
                    node.log(`Read ${priceData.length} price points`);
                }

                // Calculate number of 15-minute intervals needed (4 per hour)
                const intervalsNeeded = Math.max(1, Math.round(pendingSchedule.preheatSeconds / 900));

                // Filter valid intervals (must end before target time, start after now)
                const validIntervals = priceData.filter((item) => {
                    const intervalEnd = item.timestamp + 900; // 15 min = 900 seconds
                    return item.timestamp >= pendingSchedule.now && item.timestamp <= pendingSchedule.latestStart && intervalEnd <= pendingSchedule.targetTimestamp;
                });

                if (validIntervals.length < intervalsNeeded) {
                    throw new Error(`Not enough valid intervals: need ${intervalsNeeded}, have ${validIntervals.length}`);
                }

                // Calculate effective price for each interval (with heat loss penalty)
                const intervalsWithEffectivePrice = validIntervals.map((item) => ({
                    ...item,
                    effectivePrice: calculateEffectivePrice(item, pendingSchedule.targetTimestamp)
                }));

                // Sort by effective price (cheapest first)
                intervalsWithEffectivePrice.sort((a, b) => a.effectivePrice - b.effectivePrice);

                // Pick the cheapest N intervals
                const selectedIntervals = intervalsWithEffectivePrice.slice(0, intervalsNeeded);

                // Sort selected intervals by timestamp (chronological order)
                selectedIntervals.sort((a, b) => a.timestamp - b.timestamp);

                // Calculate totals
                const totalPrice = selectedIntervals.reduce((sum, item) => sum + item.value, 0);
                const totalEffectivePrice = selectedIntervals.reduce((sum, item) => sum + item.effectivePrice, 0);
                const avgPrice = totalPrice / selectedIntervals.length;

                // First interval start time
                const firstInterval = selectedIntervals[0];
                const bestDate = new Date(firstInterval.timestamp * 1000);
                // Last interval end time
                const lastInterval = selectedIntervals[selectedIntervals.length - 1];
                const lastIntervalEnd = lastInterval.timestamp + 900;
                const endDate = new Date(lastIntervalEnd * 1000);

                if (node.enableLogging) {
                    node.log(
                        `Selected ${selectedIntervals.length} cheapest intervals: ${bestDate.toLocaleTimeString()} - ${endDate.toLocaleTimeString()} | Total price: ${totalPrice.toFixed(0)} | Effective: ${totalEffectivePrice.toFixed(0)} | Avg: ${avgPrice.toFixed(2)}`
                    );
                }

                // Store selected intervals and move to delete step
                pendingSchedule.best = {
                    timestamp: firstInterval.timestamp, // Start of first interval
                    value: totalPrice, // Total actual price
                    effectivePrice: totalEffectivePrice, // Total effective price (with heat loss)
                    avgValue: avgPrice,
                    intervals: selectedIntervals // Store all selected intervals
                };
                pendingSchedule.bestDate = bestDate;
                pendingSchedule.endTimestamp = lastIntervalEnd; // End of last interval
                pendingSchedule.step = "deleting_old";

                node.status({ fill: "blue", shape: "dot", text: "deleting old..." });

                // Delete existing preheat events for target day
                const targetDate = new Date(pendingSchedule.targetTimestamp * 1000);
                const dayStart = Math.floor(new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0).getTime() / 1000);
                const dayEnd = dayStart + 86400;

                node.send({
                    topic: node.calendarTopic,
                    mode: "delete",
                    title: node.eventTitle,
                    start: dayStart,
                    end: dayEnd
                });
            } catch (err) {
                node.error(`Price processing failed: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: `error: ${err.message}` });
                pendingSchedule = null;
            }
        }

        /**
         * Handle delete response and create new event
         */
        function handleDeleteResponse(payload) {
            if (!pendingSchedule || pendingSchedule.step !== "deleting_old") {
                node.warn("Received delete response but no pending schedule");
                return;
            }

            try {
                let deleted = 0;
                if (typeof payload === "number") {
                    deleted = payload;
                } else if (payload && typeof payload.deleted === "number") {
                    deleted = payload.deleted;
                } else if (payload && typeof payload.count === "number") {
                    deleted = payload.count;
                }

                if (node.enableLogging && deleted > 0) {
                    node.log(`Deleted ${deleted} existing preheat event(s)`);
                }

                // Move to create step
                pendingSchedule.deleted = deleted;
                pendingSchedule.step = "creating_event";

                node.status({ fill: "blue", shape: "dot", text: "creating event..." });

                // Create preheat events from selected intervals.
                // Consecutive 15-minute slots are merged into a single event.
                const intervalSec = 900; // 15 minutes
                const intervalHours = intervalSec / 3600;
                const intervalEnergyKwh = parseFloat((node.heaterPowerKw * intervalHours).toFixed(2));
                const mergedIntervals = mergeConsecutiveIntervals(pendingSchedule.best.intervals, intervalSec);
                const events = mergedIntervals.map((group) => ({
                    topic: node.calendarTopic,
                    mode: "create",
                    title: node.eventTitle,
                    start: group.start,
                    end: group.end,
                    value: parseFloat((intervalEnergyKwh * group.count).toFixed(2))
                }));

                if (node.enableLogging) {
                    node.log(`Prepared ${events.length} merged event(s) to create:`);
                    events.forEach((event, idx) => {
                        const startTime = new Date(event.start * 1000);
                        const endTime = new Date(event.end * 1000);
                        node.log(`  Event ${idx + 1}: ${startTime.toLocaleTimeString()}-${endTime.toLocaleTimeString()} (start=${event.start}, end=${event.end})`);
                    });
                }

                // Track how many events we're creating
                pendingCreates = events.length;
                pendingSchedule.expectedCreates = events.length;
                pendingSchedule.createdCount = 0;

                // Send events sequentially with small delay to ensure each is processed
                // Even with unique keys, Node-RED processes array messages in same tick
                // Small delay ensures each message is handled before next arrives
                if (node.enableLogging) {
                    node.log(`Sending ${events.length} events with 50ms delay between each...`);
                }
                events.forEach((event, index) => {
                    setTimeout(() => {
                        if (node.enableLogging) {
                            const startTime = new Date(event.start * 1000);
                            const endTime = new Date(event.end * 1000);
                            node.log(`Sending event ${index + 1}/${events.length}: ${startTime.toLocaleTimeString()}-${endTime.toLocaleTimeString()}`);
                        }
                        node.send(event);
                    }, index * 50); // 50ms delay between each event (150ms total for 4 events)
                });
            } catch (err) {
                node.error(`Delete processing failed: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: `error: ${err.message}` });
                pendingSchedule = null;
            }
        }

        /**
         * Handle create response and finish
         */
        function handleCreateResponse(payload) {
            if (!pendingSchedule || pendingSchedule.step !== "creating_event") {
                node.warn("Received create response but no pending schedule");
                return;
            }

            try {
                if (node.enableLogging) {
                    node.log(`Create response received: ${JSON.stringify(payload)}`);
                }

                // Check if creation was successful
                if (payload && payload.success === false) {
                    throw new Error(payload.error || "Failed to create event");
                }

                // Increment created count
                pendingSchedule.createdCount = (pendingSchedule.createdCount || 0) + 1;

                // Wait for all events to be created before finishing
                if (pendingSchedule.createdCount < pendingSchedule.expectedCreates) {
                    if (node.enableLogging) {
                        node.log(`Created ${pendingSchedule.createdCount}/${pendingSchedule.expectedCreates} events...`);
                    }
                    return; // Wait for more responses
                }

                // All events created!
                const elapsed = ((Date.now() - pendingSchedule.startTime) / 1000).toFixed(2);
                const intervals = pendingSchedule.best.intervals;
                const priceStr = pendingSchedule.best.value.toFixed(0);

                // Format status: show start times only for brevity
                // e.g., "preheat: 19:00,19:30,20:00,20:30 (9772)" or "preheat: 4x15min from 19:00 (9772)"
                let statusText;
                if (intervals.length <= 4) {
                    // Show all start times if 4 or fewer
                    const times = intervals
                        .map((interval) => {
                            const d = new Date(interval.timestamp * 1000);
                            return `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
                        })
                        .join(",");
                    statusText = `preheat: ${times} (${priceStr})`;
                } else {
                    // Show first time and count if more than 4
                    const firstDate = new Date(intervals[0].timestamp * 1000);
                    const firstStr = `${firstDate.getHours()}:${firstDate.getMinutes().toString().padStart(2, "0")}`;
                    statusText = `preheat: ${intervals.length}x15min from ${firstStr} (${priceStr})`;
                }

                node.status({
                    fill: "green",
                    shape: "dot",
                    text: statusText
                });

                if (node.enableLogging) {
                    const times = intervals
                        .map((interval) => {
                            const d = new Date(interval.timestamp * 1000);
                            return `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
                        })
                        .join(",");
                    node.log(
                        `OK Preheat scheduled: ${times} (${intervals.length}x15min), total: ${priceStr}, avg: ${pendingSchedule.best.avgValue.toFixed(2)}, elapsed: ${elapsed}s`
                    );
                }

                // Store expected event count for verification (merged events)
                const expectedEventCount = pendingSchedule.expectedCreates || intervals.length;

                // Verify events were created by reading them back
                // Use a small delay to ensure DB commit is complete
                setTimeout(() => {
                    const verifyStart = intervals[0].timestamp - 3600; // 1 hour before first
                    const verifyEnd = intervals[intervals.length - 1].timestamp + 1800; // 30 min after last
                    node.send({
                        topic: node.calendarTopic,
                        mode: "read",
                        title: node.eventTitle,
                        start: verifyStart,
                        end: verifyEnd,
                        _verify: true, // Flag to identify verification response
                        _expectedCount: expectedEventCount
                    });
                }, 500); // Wait 500ms for DB to update

                pendingSchedule = null;
            } catch (err) {
                node.error(`Event creation failed: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: `error: ${err.message}` });
                pendingSchedule = null;
            }
        }

        // Listen for trigger messages and calendar responses
        node.on("input", function (msg) {
            if (!msg || !msg.topic) {
                if (node.enableLogging) {
                    node.warn("Received message without topic, ignoring");
                }
                return;
            }

            if (node.enableLogging) {
                node.log(`Received msg.topic="${msg.topic}", expecting calendarTopic="${node.calendarTopic}"`);
            }

            // Calendar response (all operations use same topic) - check this FIRST
            if (msg.topic === node.calendarTopic) {
                if (pendingSchedule) {
                    if (node.enableLogging) {
                        node.log(`OK Calendar response for step: ${pendingSchedule.step}`);
                    }
                    // Handle based on current step
                    if (pendingSchedule.step === "reading_prices") {
                        handlePriceData(msg.payload);
                    } else if (pendingSchedule.step === "deleting_old") {
                        handleDeleteResponse(msg.payload);
                    } else if (pendingSchedule.step === "creating_event") {
                        handleCreateResponse(msg.payload);
                    }
                } else if (msg._verify) {
                    // This is a verification read response
                    // Calendar stores each event as 2 rows (start and end), so count unique events
                    const foundRows = Array.isArray(msg.payload) ? msg.payload : [];
                    // Count unique events by unique mids (preferred), fallback to non-empty value rows.
                    const uniqueEvents = new Set();
                    foundRows.forEach((row) => {
                        // Each event has a mid.
                        if (row.mid !== undefined && row.mid !== null) {
                            uniqueEvents.add(row.mid);
                        } else if (row.value !== "" && row.value !== null && row.value !== undefined) {
                            // Fallback: count rows that carry numeric event value.
                            uniqueEvents.add(row.timestamp);
                        }
                    });
                    const foundCount = uniqueEvents.size;
                    const expectedCount = msg._expectedCount || 0;
                    if (foundCount === expectedCount) {
                        if (node.enableLogging) {
                            node.log(`OK Verification: All ${expectedCount} events found in calendar`);
                        }
                    } else {
                        node.warn(`Verification: Expected ${expectedCount} events, found ${foundCount} (${foundRows.length} rows)`);
                    }
                } else if (node.enableLogging) {
                    node.log(`Calendar response received but no pending schedule`);
                }
                return;
            }

            // Trigger: start scheduling (any other topic, or specific trigger topic if configured)
            if (!node.triggerTopic || msg.topic === node.triggerTopic) {
                if (node.enableLogging) {
                    node.warn("Trigger received, starting scheduler...");
                }
                startScheduler();
                return;
            }

            if (node.enableLogging) {
                node.warn(`Received message with unmatched topic: "${msg.topic}" (expected "${node.calendarTopic}" or trigger)`);
            }
        });

        node.on("close", function () {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-sauna-scheduler", SaunaSchedulerNode);
};
