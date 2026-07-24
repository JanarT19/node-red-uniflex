/**
 * holidays-fetcher.js
 *
 * Fetches holidays from Google Calendar (iCal format) and writes them to
 * sql-calendar node as "holiday" events. All event titles are ignored -
 * all events are stored with the configured title (default: "holiday").
 */

const https = require("https");
const http = require("http");

const NODE_VERSION = "0.1.2";

module.exports = function (RED) {
    function HolidaysFetcherNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.calendarUrl = config.calendarUrl || "";
        node.calendarTitle = config.calendarTitle || "holiday";
        node.calendarTopic = config.calendarTopic || "calendar/holidays";
        node.enableLogging = config.enableLogging !== false;
        node.debugTopics = (config.debugTopics || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (node.enableLogging) {
            node.log(`[holidays-fetcher v${NODE_VERSION}] Initialized | URL: ${node.calendarUrl || "not set"} | Title: ${node.calendarTitle}`);
        }

        node.status({ fill: "grey", shape: "ring", text: "idle" });

        const log = (msg, topic) => {
            if (!node.enableLogging) return;
            if (node.debugTopics.length === 0 || (topic && node.debugTopics.some((p) => topic.startsWith(p)))) {
                node.log(`[holidays-fetcher v${NODE_VERSION}] ${msg}`);
            }
        };

        const warn = (msg) => node.warn(`[holidays-fetcher v${NODE_VERSION}] ${msg}`);
        const err = (msg) => node.error(`[holidays-fetcher] ${msg}`);

        function makeRequest(url, timeoutMs = 10000) {
            return new Promise((resolve, reject) => {
                const lib = url.startsWith("https") ? https : http;
                const req = lib.get(url, { timeout: timeoutMs }, (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        }
                        resolve(data);
                    });
                });
                req.on("timeout", () => {
                    req.destroy(new Error("Request timeout"));
                });
                req.on("error", reject);
            });
        }

        function parseICalEvents(icalText, startTs, endTs) {
            const events = [];
            const lines = icalText.split(/\r?\n/);
            let currentEvent = null;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith("BEGIN:VEVENT")) {
                    currentEvent = {};
                } else if (line.startsWith("END:VEVENT")) {
                    if (currentEvent && currentEvent.timestamp) {
                        if (currentEvent.timestamp >= startTs && currentEvent.timestamp < endTs + 86400) {
                            events.push(currentEvent);
                        }
                        currentEvent = null;
                    }
                } else if (currentEvent && line.startsWith("DTSTART")) {
                    // DTSTART;VALUE=DATE:20240101 or DTSTART:20240101T000000Z
                    const match = line.match(/[:;](\d{8})/);
                    if (match) {
                        const dateStr = match[1]; // YYYYMMDD
                        const year = parseInt(dateStr.substr(0, 4), 10);
                        const month = parseInt(dateStr.substr(4, 2), 10) - 1;
                        const day = parseInt(dateStr.substr(6, 2), 10);
                        const timestamp = Math.floor(new Date(year, month, day, 0, 0, 0, 0).getTime() / 1000);
                        currentEvent.timestamp = timestamp;
                        currentEvent.value = 1;
                    }
                }
            }

            return events;
        }

        async function runOnce(send) {
            if (!node.calendarUrl) {
                throw new Error("Calendar URL not configured");
            }

            // Fetch window: yesterday to 1 year ahead
            const now = new Date();
            const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
            const startTs = Math.floor(yesterday.getTime() / 1000);
            const endTs = startTs + 366 * 24 * 3600; // 1 year + 1 day

            // Step 1: Fetch from calendar
            node.status({ fill: "blue", shape: "dot", text: "fetching..." });
            warn(`Fetching holidays from calendar | title=${node.calendarTitle} | url=${node.calendarUrl} | window ${startTs}..${endTs}`);

            const icalText = await makeRequest(node.calendarUrl, 10000);

            const uniqueEvents = parseICalEvents(icalText, startTs, endTs).sort((a, b) => a.timestamp - b.timestamp);

            if (uniqueEvents.length === 0) {
                warn(`No holiday events found | title=${node.calendarTitle}`);
                node.status({ fill: "yellow", shape: "ring", text: "no events" });
                return;
            }

            warn(`Found ${uniqueEvents.length} unique holiday events | title=${node.calendarTitle}`);

            // Step 2: Delete all events with this title (wide date range to cover everything)
            node.status({ fill: "blue", shape: "dot", text: "deleting old..." });
            send({
                topic: node.calendarTopic,
                mode: "delete",
                title: node.calendarTitle,
                start: 0,
                end: 2147483647 // max 32-bit timestamp (year 2038)
            });

            // Step 3: Create new events (after delay to let delete complete)
            await new Promise((resolve) => setTimeout(resolve, 1000));

            node.status({ fill: "blue", shape: "dot", text: "creating..." });
            for (const evt of uniqueEvents) {
                send({
                    topic: node.calendarTopic,
                    mode: "create",
                    title: node.calendarTitle,
                    start: evt.timestamp,
                    end: evt.timestamp + 86400,
                    value: evt.value
                });
            }

            node.status({ fill: "green", shape: "dot", text: `${uniqueEvents.length} events` });
            warn(`Completed | title=${node.calendarTitle} | ${uniqueEvents.length} events sent to calendar`);
        }

        node.on("input", async (_msg, send, done) => {
            try {
                await runOnce(send);
                done();
            } catch (e) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                err(e.message);
                done(e);
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-holidays-fetcher", HolidaysFetcherNode);
};
