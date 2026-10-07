"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("../../core/lib/timestamp.js");
const core = require("./live-chart-core.js");

const PAGE_HTML = fs.readFileSync(path.join(__dirname, "live-chart-page.html"), "utf8");
const WALL_HTML = fs.readFileSync(path.join(__dirname, "live-chart-wall.html"), "utf8");
const ROUTE_ROOT = "/uniflex/live-chart";

function registerRoutes(RED) {
    if (!RED.httpNode || RED.httpNode._uniflexLiveChartRegistry) return null;

    const registry = new Map();
    RED.httpNode._uniflexLiveChartRegistry = registry;

    function findNode(req, res) {
        const node = registry.get(req.params.id);
        if (!node) {
            res.status(404).json({ error: "Live chart node not found" });
            return null;
        }
        return node;
    }

    RED.httpNode.get(`${ROUTE_ROOT}/chart.js`, (req, res) => {
        try {
            const packageEntry = require.resolve("chart.js");
            res.sendFile(path.join(path.dirname(packageEntry), "chart.umd.js"));
        } catch (error) {
            res.status(500).send(`Chart.js is unavailable: ${error.message}`);
        }
    });

    RED.httpNode.get(`${ROUTE_ROOT}/wall/catalog`, (req, res) => {
        const charts = Array.from(registry.values())
            .map((node) => ({ id: node.id, name: node.name || "Live datastream chart" }))
            .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
        res.json({
            serverTime: Date.now(),
            charts,
            limits: {
                refreshSeconds: core.REFRESH_SECONDS,
                timespanMinutes: core.TIMESPAN_MINUTES
            }
        });
    });

    RED.httpNode.get(`${ROUTE_ROOT}/wall`, (req, res) => {
        res.type("html").send(WALL_HTML);
    });

    RED.httpNode.get(`${ROUTE_ROOT}/:id`, (req, res) => {
        if (!findNode(req, res)) return;
        res.type("html").send(PAGE_HTML);
    });

    RED.httpNode.get(`${ROUTE_ROOT}/:id/state`, (req, res) => {
        const node = findNode(req, res);
        if (node) res.json(node.liveChartState(true));
    });

    RED.httpNode.post(`${ROUTE_ROOT}/:id/settings`, (req, res) => {
        const node = findNode(req, res);
        if (!node) return;
        try {
            res.json(node.liveChartUpdateSettings(req.body || {}));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    RED.httpNode.post(`${ROUTE_ROOT}/:id/clear`, (req, res) => {
        const node = findNode(req, res);
        if (!node) return;
        node.liveChartClear();
        res.json(node.liveChartState(true));
    });

    RED.httpNode.post(`${ROUTE_ROOT}/:id/close`, (req, res) => {
        const node = findNode(req, res);
        if (!node) return;
        node.liveChartDeactivate();
        res.status(204).send();
    });

    return registry;
}

module.exports = function (RED) {
    const registry = registerRoutes(RED) || RED.httpNode?._uniflexLiveChartRegistry;

    function LiveChartNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.sourceReadNode = config.sourceReadNode || "";
        node.source = RED.nodes.getNode(node.sourceReadNode);

        const buffers = new core.SlidingBuffers();
        const latest = new Map();
        const settingsContext = node.context();
        let settings = {
            refreshSeconds: 5,
            timespanMinutes: 10,
            selected: [],
            axisStyles: { ...core.DEFAULT_AXIS_STYLES }
        };
        let persistedSettings = null;
        let pendingStoredSettings = null;
        let active = false;
        let lastHeartbeat = 0;
        let activeSince = 0;
        let expiryTimer = null;
        let lastStatusUpdate = 0;

        function resolveSource() {
            const current = RED.nodes.getNode(node.sourceReadNode);
            node.source = current && Array.isArray(current.mappings) ? current : null;
            return node.source;
        }

        function catalog() {
            return core.buildCatalog(resolveSource());
        }

        function serviceMetadataReady() {
            const source = resolveSource();
            const services = source?.controller?.services;
            return !!services && Object.keys(services).length > 0;
        }

        function serviceMetadataWarning() {
            const source = resolveSource();
            const error = source?.controller?.servicesError;
            if (error) return error;
            if (!serviceMetadataReady()) {
                return "Services metadata is unavailable; units and service names may be incorrect";
            }
            return null;
        }

        function persistSettings(next) {
            if (persistedSettings && core.settingsEqual(next, persistedSettings)) return;
            try {
                settingsContext.set("settings", next, "file");
                persistedSettings = next;
            } catch (error) {
                node.warn(`Could not persist live chart settings: ${error.message}`);
            }
        }

        function finishPendingRestore() {
            if (!pendingStoredSettings || !serviceMetadataReady()) return false;
            settings = core.restoreSettings(pendingStoredSettings, catalog(), settings);
            pendingStoredSettings = null;
            persistSettings(settings);
            return true;
        }

        function selectedTopics() {
            return settings.selected.map((item) => item.topic);
        }

        function cutoff(now = Date.now()) {
            return now - settings.timespanMinutes * 60000;
        }

        function setInactiveStatus() {
            node.status({ fill: "grey", shape: "ring", text: `Inactive (${ts.formatStatus()})` });
        }

        function updateActiveStatus(force) {
            const now = Date.now();
            if (!force && now - lastStatusUpdate < 1000) return;
            lastStatusUpdate = now;
            const seriesCount = settings.selected.length;
            node.status({
                fill: seriesCount ? "green" : "blue",
                shape: "dot",
                text: `${seriesCount ? "Viewer active" : "Viewer active, select streams"}: ${seriesCount} series, ${buffers.pointCount()} points (${ts.formatStatus(now)})`
            });
        }

        function stopExpiryTimer() {
            if (expiryTimer) {
                clearInterval(expiryTimer);
                expiryTimer = null;
            }
        }

        function deactivate() {
            active = false;
            lastHeartbeat = 0;
            activeSince = 0;
            stopExpiryTimer();
            buffers.clear();
            latest.clear();
            setInactiveStatus();
        }

        function checkExpiry() {
            const timeoutMs = core.heartbeatTimeoutMs(settings.refreshSeconds);
            if (active && Date.now() - lastHeartbeat > timeoutMs) deactivate();
        }

        function touch() {
            const now = Date.now();
            lastHeartbeat = now;
            if (!active) {
                active = true;
                activeSince = now;
                expiryTimer = setInterval(checkExpiry, 5000);
            }
            updateActiveStatus(true);
        }

        function state(heartbeat) {
            finishPendingRestore();
            if (heartbeat) touch();
            const now = Date.now();
            const topics = selectedTopics();
            const points = active ? buffers.snapshot(cutoff(now), topics) : {};
            const current = {};
            topics.forEach((topic) => {
                if (latest.has(topic)) current[topic] = latest.get(topic);
            });
            const list = catalog();
            const byTopic = new Map(list.map((item) => [item.topic, item]));
            return {
                nodeId: node.id,
                name: node.name || "Live datastream chart",
                active,
                activeSince,
                serverTime: now,
                settings,
                metadataWarning: serviceMetadataWarning(),
                axisUnits: core.axisUnits(settings.selected, byTopic),
                catalog: list,
                points,
                latest: current,
                limits: {
                    refreshSeconds: core.REFRESH_SECONDS,
                    timespanMinutes: core.TIMESPAN_MINUTES,
                    maxSeries: core.MAX_SERIES
                }
            };
        }

        node.liveChartState = state;
        node.liveChartUpdateSettings = function (input) {
            finishPendingRestore();
            if (pendingStoredSettings) {
                const pendingInput = {
                    refreshSeconds: input?.refreshSeconds ?? settings.refreshSeconds,
                    timespanMinutes: input?.timespanMinutes ?? settings.timespanMinutes,
                    selected: Array.isArray(input?.selected) ? input.selected : settings.selected,
                    axisStyles: input?.axisStyles || settings.axisStyles
                };
                settings = core.restoreSettings(pendingInput, catalog(), settings, { validateUnits: false });
                pendingStoredSettings = settings;
                touch();
                return state(false);
            }
            const next = core.validateSettings(input, catalog(), settings);
            const changed = !core.settingsEqual(next, settings);
            settings = next;
            if (changed) persistSettings(settings);
            const topics = selectedTopics();
            buffers.prune(cutoff(), topics);
            for (const topic of latest.keys()) {
                if (!topics.includes(topic)) latest.delete(topic);
            }
            touch();
            return state(false);
        };
        node.liveChartClear = function () {
            buffers.clear();
            latest.clear();
            updateActiveStatus(true);
        };
        node.liveChartDeactivate = deactivate;

        if (!resolveSource() || !Array.isArray(node.source.mappings)) {
            node.status({ fill: "red", shape: "dot", text: `Invalid read node (${ts.formatStatus()})` });
            node.error("A deployed uniflex-read-data-streams source node is required");
        } else {
            try {
                const stored = settingsContext.get("settings", "file");
                if (stored && typeof stored === "object") {
                    persistedSettings = stored;
                    if (serviceMetadataReady()) {
                        settings = core.restoreSettings(stored, catalog(), settings);
                        persistSettings(settings);
                    } else {
                        settings = core.restoreSettings(stored, catalog(), settings, { validateUnits: false });
                        pendingStoredSettings = settings;
                    }
                }
            } catch (error) {
                node.warn(`Could not restore live chart settings: ${error.message}`);
            }
            setInactiveStatus();
        }

        if (registry) registry.set(node.id, node);

        node.on("input", (msg, send, done) => {
            if (!active) {
                if (done) done();
                return;
            }
            checkExpiry();
            if (!active) {
                if (done) done();
                return;
            }

            const selected = new Set(selectedTopics());
            const values = core.normalizeInput(msg, selected);
            if (values.length > 0) {
                const now = Date.now();
                const oldest = cutoff(now);
                values.forEach((item) => {
                    if (item.value === null) {
                        latest.delete(item.topic);
                    } else {
                        buffers.append(item.topic, now, item.value, oldest);
                        latest.set(item.topic, { timestamp: now, value: item.value });
                    }
                });
                updateActiveStatus(false);
            }
            if (done) done();
        });

        node.on("close", (removed, done) => {
            deactivate();
            if (registry) registry.delete(node.id);
            if (done) done();
        });
    }

    RED.nodes.registerType("uniflex-live-chart", LiveChartNode);
};
