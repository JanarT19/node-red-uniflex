"use strict";

const REFRESH_SECONDS = [1, 2, 5, 10, 30];
const TIMESPAN_MINUTES = [1, 2, 5, 10, 15, 30, 60];
const MAX_SERIES = 16;
const MAX_POINTS_PER_SERIES = 10000;
const MAX_RETURNED_POINTS_PER_SERIES = 1500;
const AXIS_STYLES = ["line", "area", "stacked"];
const DEFAULT_AXIS_STYLES = { left: "line", right: "area" };

function normalizeUnit(value) {
    const unit = value == null ? "" : String(value).trim();
    return unit && unit !== "_" ? unit : "_";
}

function heartbeatTimeoutMs(refreshSeconds) {
    return Math.max(15000, Number(refreshSeconds) * 3000);
}

function serviceKeyFor(row) {
    const configured = row?.keyNameSelect || row?.keyNameManual;
    if (configured) {
        return String(configured).trim().replace(/\.\d+$/, "");
    }
    const topic = String(row?.topic || "").trim();
    return topic.includes(".") ? topic.split(".")[0] : "";
}

function buildCatalog(sourceNode) {
    const mappings = Array.isArray(sourceNode?.mappings) ? sourceNode.mappings : [];
    const controller = sourceNode?.controller || {};
    const services = controller.services || {};
    const channels = controller.channels || {};
    const seen = new Set();
    const catalog = [];

    mappings.forEach((row) => {
        if (row?.dataType !== "value") return;
        const topic = String(row.topic || "").trim();
        const key = serviceKeyFor(row);
        const member = Number.parseInt(row.index, 10);
        if (!topic || !key || !Number.isInteger(member) || seen.has(topic)) return;

        const service = services[key] || {};
        const channel = channels?.[key]?.[member] || {};
        const unit = normalizeUnit(service.out_unit);
        const serviceName = String(service.servicename || key);
        const memberDescription = String(channel.desc || service?.desc?.[member - 1] || "").trim();
        const description = memberDescription ? `${serviceName} (${memberDescription})` : serviceName;

        seen.add(topic);
        catalog.push({
            topic,
            key,
            member,
            unit,
            description,
            label: `${topic}: ${description}`
        });
    });

    return catalog.sort((a, b) => a.topic.localeCompare(b.topic, undefined, { numeric: true }));
}

function normalizeInput(msg, allowedTopics) {
    const values = [];
    const add = (topic, value) => {
        if (!allowedTopics.has(topic)) return;
        if (value === null || value === undefined || value === "") {
            values.push({ topic, value: null });
            return;
        }
        const numeric = Number(value);
        values.push({ topic, value: Number.isFinite(numeric) ? numeric : null });
    };

    if (msg && typeof msg.topic === "string") {
        add(msg.topic, msg.payload);
    } else if (msg?.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        Object.entries(msg.payload).forEach(([topic, value]) => add(topic, value));
    }

    return values;
}

function decimateMinMax(points, limit = MAX_RETURNED_POINTS_PER_SERIES) {
    if (points.length <= limit) return points.slice();
    const bucketCount = Math.max(1, Math.floor(limit / 2));
    const bucketSize = points.length / bucketCount;
    const result = [];

    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const start = Math.floor(bucket * bucketSize);
        const end = Math.min(points.length, Math.floor((bucket + 1) * bucketSize));
        let minPoint = points[start];
        let maxPoint = points[start];
        for (let index = start + 1; index < end; index += 1) {
            if (points[index][1] < minPoint[1]) minPoint = points[index];
            if (points[index][1] > maxPoint[1]) maxPoint = points[index];
        }
        if (minPoint === maxPoint) {
            result.push(minPoint);
        } else if (minPoint[0] < maxPoint[0]) {
            result.push(minPoint, maxPoint);
        } else {
            result.push(maxPoint, minPoint);
        }
    }
    return result;
}

function axisUnits(selected, catalogByTopic) {
    const units = { left: null, right: null };
    selected.forEach((item) => {
        const unit = catalogByTopic.get(item.topic)?.unit;
        if (unit && !units[item.axis]) units[item.axis] = unit;
    });
    return units;
}

function validateSettings(input, catalog, fallback) {
    const previous = fallback || { refreshSeconds: 5, timespanMinutes: 10, selected: [], axisStyles: DEFAULT_AXIS_STYLES };
    const refreshSeconds = Number(input?.refreshSeconds ?? previous.refreshSeconds);
    const timespanMinutes = Number(input?.timespanMinutes ?? previous.timespanMinutes);
    if (!REFRESH_SECONDS.includes(refreshSeconds)) throw new Error("Unsupported refresh period");
    if (!TIMESPAN_MINUTES.includes(timespanMinutes)) throw new Error("Unsupported timespan");
    const previousStyles = previous.axisStyles || DEFAULT_AXIS_STYLES;
    const requestedStyles = input?.axisStyles;
    const axisStyles = {
        left: requestedStyles?.left ?? previousStyles.left ?? DEFAULT_AXIS_STYLES.left,
        right: requestedStyles?.right ?? previousStyles.right ?? DEFAULT_AXIS_STYLES.right
    };
    Object.entries(axisStyles).forEach(([axis, style]) => {
        if (!AXIS_STYLES.includes(style)) throw new Error(`Unsupported ${axis} axis style`);
    });

    const catalogByTopic = new Map(catalog.map((item) => [item.topic, item]));
    const requested = Array.isArray(input?.selected) ? input.selected : previous.selected;
    if (requested.length > MAX_SERIES) throw new Error(`At most ${MAX_SERIES} series may be selected`);

    const seen = new Set();
    const selected = requested.map((item) => {
        const topic = String(item?.topic || "").trim();
        const axis = item?.axis === "right" ? "right" : item?.axis === "left" ? "left" : "";
        if (!catalogByTopic.has(topic)) throw new Error(`Unknown data stream topic: ${topic}`);
        if (!axis) throw new Error(`Invalid axis for ${topic}`);
        if (seen.has(topic)) throw new Error(`Duplicate data stream topic: ${topic}`);
        seen.add(topic);
        return { topic, axis };
    });

    const units = { left: null, right: null };
    selected.forEach((item) => {
        const unit = catalogByTopic.get(item.topic).unit;
        if (units[item.axis] && units[item.axis] !== unit) {
            throw new Error(`${item.axis} axis already uses unit ${units[item.axis]}`);
        }
        units[item.axis] = unit;
    });
    if (units.left && units.right && units.left === units.right) {
        throw new Error("Left and right axes must use different units");
    }

    return { refreshSeconds, timespanMinutes, selected, axisStyles };
}

function restoreSettings(input, catalog, fallback, options) {
    const previous = fallback || { refreshSeconds: 5, timespanMinutes: 10, selected: [], axisStyles: DEFAULT_AXIS_STYLES };
    const validateUnits = options?.validateUnits !== false;
    const refreshSeconds = Number(input?.refreshSeconds);
    const timespanMinutes = Number(input?.timespanMinutes);
    const requestedStyles = input?.axisStyles || {};
    let restored = validateSettings(
        {
            refreshSeconds: REFRESH_SECONDS.includes(refreshSeconds) ? refreshSeconds : previous.refreshSeconds,
            timespanMinutes: TIMESPAN_MINUTES.includes(timespanMinutes) ? timespanMinutes : previous.timespanMinutes,
            selected: [],
            axisStyles: {
                left: AXIS_STYLES.includes(requestedStyles.left) ? requestedStyles.left : previous.axisStyles.left,
                right: AXIS_STYLES.includes(requestedStyles.right) ? requestedStyles.right : previous.axisStyles.right
            }
        },
        catalog,
        previous
    );

    const requested = Array.isArray(input?.selected) ? input.selected : [];
    if (!validateUnits) {
        const catalogTopics = new Set(catalog.map((item) => item.topic));
        const seen = new Set();
        requested.forEach((item) => {
            const topic = String(item?.topic || "").trim();
            const axis = item?.axis === "right" ? "right" : item?.axis === "left" ? "left" : "";
            if (!topic || !axis || !catalogTopics.has(topic) || seen.has(topic) || restored.selected.length >= MAX_SERIES) return;
            seen.add(topic);
            restored.selected.push({ topic, axis });
        });
        return restored;
    }

    requested.forEach((item) => {
        try {
            restored = validateSettings({ selected: [...restored.selected, item] }, catalog, restored);
        } catch (error) {
            // Ignore selections that no longer exist or violate current axis rules.
        }
    });
    return restored;
}

function settingsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

class SlidingBuffers {
    constructor(maxPointsPerSeries = MAX_POINTS_PER_SERIES) {
        this.maxPointsPerSeries = maxPointsPerSeries;
        this.series = new Map();
    }

    append(topic, timestamp, value, cutoff) {
        const points = this.series.get(topic) || [];
        points.push([timestamp, value]);
        let first = 0;
        while (first < points.length && points[first][0] < cutoff) first += 1;
        if (first > 0) points.splice(0, first);
        if (points.length > this.maxPointsPerSeries) {
            points.splice(0, points.length - this.maxPointsPerSeries);
        }
        this.series.set(topic, points);
    }

    prune(cutoff, selectedTopics) {
        const selected = new Set(selectedTopics);
        for (const [topic, points] of this.series.entries()) {
            if (!selected.has(topic)) {
                this.series.delete(topic);
                continue;
            }
            let first = 0;
            while (first < points.length && points[first][0] < cutoff) first += 1;
            if (first > 0) points.splice(0, first);
        }
    }

    snapshot(cutoff, selectedTopics) {
        this.prune(cutoff, selectedTopics);
        const result = {};
        selectedTopics.forEach((topic) => {
            result[topic] = decimateMinMax(this.series.get(topic) || []);
        });
        return result;
    }

    clear() {
        this.series.clear();
    }

    pointCount() {
        let count = 0;
        this.series.forEach((points) => {
            count += points.length;
        });
        return count;
    }
}

module.exports = {
    REFRESH_SECONDS,
    TIMESPAN_MINUTES,
    MAX_SERIES,
    AXIS_STYLES,
    DEFAULT_AXIS_STYLES,
    normalizeUnit,
    heartbeatTimeoutMs,
    buildCatalog,
    normalizeInput,
    decimateMinMax,
    axisUnits,
    validateSettings,
    restoreSettings,
    settingsEqual,
    SlidingBuffers
};
