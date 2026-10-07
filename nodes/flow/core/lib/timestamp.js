/**
 * Shared timestamp formatting for all uniflex Node-RED nodes.
 *
 * Use in any node:
 *   const ts = require("<relative>/core/lib/timestamp.js");
 *
 * Status text:  ts.formatStatus()           -> DD.MM.YYYY HH:MM:SS
 * Log fields:    ts.formatLogSuffix({...})  -> ts_s=..., ts_ms=..., wall=...
 * node.log is not prefixed (NR already timestamps). warn/error keep ts_ms/wall.
 * Epoch ms:      ts.nowMs()
 *
 * After wrapNode, pass plain messages to warn/error/log -- do not also prefix
 * [HH:MM:SS] or formatStatus() in the node. formatLogSuffix is for latency
 * traces only (guard skips a second prefix if ts_ms+wall are already present).
 *
 * wall format: European date, 24h clock, millisecond after comma (ASCII only).
 */

function nowMs() {
    return Date.now();
}

function normalizeEpochMs(value) {
    if (value === undefined || value === null || value === "") {
        return nowMs();
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return nowMs();
    }
    if (n > 0 && n < 1e12) {
        return Math.round(n * 1000);
    }
    return Math.round(n);
}

function normalizeEpochSec(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return undefined;
    }
    if (n >= 1e12) {
        return Math.floor(n / 1000);
    }
    return Math.floor(n);
}

function formatWall(epochMs, withMs) {
    const ms = normalizeEpochMs(epochMs);
    const d = new Date(ms);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const base = `${dd}.${mm}.${yyyy} ${hh}:${min}:${ss}`;
    if (withMs === false) return base;
    const mss = String(d.getMilliseconds()).padStart(3, "0");
    return `${base},${mss}`;
}

function formatStatus(epochMs) {
    return formatWall(epochMs, false);
}

/**
 * Structured suffix for latency / trace logs.
 * opts: { nrMs, iolayerSec, udpSendSec, label }
 */
function formatLogSuffix(opts) {
    const o = opts || {};
    const nrMs = normalizeEpochMs(o.nrMs ?? o.tsMs);
    const parts = [`ts_ms=${nrMs}`, `wall=${formatWall(nrMs)}`];
    const iolayerSec = normalizeEpochSec(o.iolayerSec ?? o.tsS ?? o.ts);
    if (iolayerSec !== undefined) {
        parts.unshift(`ts_s=${iolayerSec}`);
    }
    const udpSendSec = o.udpSendSec ?? o.udpS;
    if (udpSendSec !== undefined && udpSendSec !== null && udpSendSec !== "") {
        const udpN = Number(udpSendSec);
        if (Number.isFinite(udpN)) {
            parts.push(`udp_s=${udpN}`);
        }
    }
    if (o.label) {
        parts.unshift(String(o.label));
    }
    return parts.join(", ");
}

function prefixLogMessage(msg) {
    const text = msg === undefined || msg === null ? "" : String(msg);
    if (text.includes("ts_ms=") && text.includes("wall=")) {
        return text;
    }
    return `${formatLogSuffix({ nrMs: nowMs() })} ${text}`;
}

/**
 * Prefix node.warn / node.error with ts_ms and wall time.
 * node.log is left plain (NR log line already has a timestamp).
 * Call once after RED.nodes.createNode(this, config).
 */
function wrapNode(node) {
    if (!node || node._uniflexTsWrapped) {
        return node;
    }
    node._uniflexTsWrapped = true;
    if (typeof node.log === "function") {
        node._uniflexOrigLog = node.log.bind(node);
    }
    ["warn", "error"].forEach((fn) => {
        if (typeof node[fn] !== "function") {
            return;
        }
        const orig = node[fn].bind(node);
        node[fn] = function (msg, ...args) {
            return orig(prefixLogMessage(msg), ...args);
        };
    });
    return node;
}

module.exports = {
    nowMs,
    normalizeEpochMs,
    normalizeEpochSec,
    formatWall,
    formatStatus,
    formatLogSuffix,
    prefixLogMessage,
    wrapNode,
    // Legacy alias used in many status strings
    formatDate: formatStatus
};
