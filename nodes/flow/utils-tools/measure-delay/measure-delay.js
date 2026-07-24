const ts = require("../../core/lib/timestamp.js");
/**
 * This node measures the delay between a "trigger" message and a matching response ("partner") message.
 *  - waits until partner == trigger  -> ok  (trig = part = val)
 *  - during wait: mismatch updates badge, keeps waiting
 *  - after ok   : mismatch badge + message if values diverge again
 *  - timeout    : red badge + message with both values
 *  - null / undefined never match anything
 */
module.exports = function (RED) {
    function DelayedCompareNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        const trigTopic = (config.trigger || "").trim();
        const partTopic = (config.partner || "").trim(); // blank = any topic
        const timeoutMs = Number(config.timeout) || 1000;
        const responseType = config.responseType || "exact"; // exact, tolerance, or any_change
        const tolerance = Number(config.tolerance) || 0;
        const suppressTimeoutMessage = !!config.suppressTimeoutMessage;
        const systemLogging = !!config.systemLogging;
        const triggerOnChangeOnly = !!config.triggerOnChangeOnly;

        // Initialize node state variables
        let armed = false; // in waiting phase?
        let timedOut = false; // timeout occurred but still waiting for response
        let refVal = undefined; // trigger value for current wait
        let timer = null;
        let lastPartner = undefined; // last partner value
        let tStart = 0; // ms epoch when armed
        let lastMeasuredMs = null; // keep latest successful measured delay
        let lastMeasuredWasLate = false;
        let lastArmedTrigger = undefined;
        let hasLastArmedTrigger = false;
        let partnerValAtArm = undefined;
        let lastStatus = null;

        // Helper functions
        function isNumeric(v) {
            return (typeof v === "number" && !isNaN(v)) || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)));
        }

        function compareValues(a, b) {
            // undefined/null never match
            if (a === undefined || b === undefined) return false;
            if (a === null || b === null) return false;

            // If tolerance mode and both numeric-ish, compare numerically
            if (responseType === "tolerance" && isNumeric(a) && isNumeric(b)) {
                const na = Number(a);
                const nb = Number(b);
                return Math.abs(na - nb) <= tolerance;
            }

            // If both objects, deep-compare via JSON
            if (typeof a === "object" && typeof b === "object") {
                try {
                    return JSON.stringify(a) === JSON.stringify(b);
                } catch (e) {
                    return false;
                }
            }

            // Fallback to strict equality for scalars
            return a === b;
        }

        function partnerMatches(partnerVal, triggerVal) {
            if (responseType === "any_change") {
                if (partnerValAtArm === undefined) {
                    return true;
                }
                // Partner changed since trigger armed
                if (!compareValues(partnerVal, partnerValAtArm)) {
                    return true;
                }
                // Inverted response (e.g. trigger 1, partner 0)
                if (!compareValues(partnerVal, triggerVal)) {
                    return true;
                }
                // Same-direction: partner reached trigger value from a different start
                if (compareValues(partnerVal, triggerVal) && !compareValues(partnerValAtArm, triggerVal)) {
                    return true;
                }
                return false;
            }
            return compareValues(partnerVal, triggerVal);
        }

        function jsonShort(v) {
            try {
                const s = JSON.stringify(v);
                return s.length > 120 ? `${s.slice(0, 117)}...` : s;
            } catch (e) {
                return String(v);
            }
        }

        function applyStatus(status) {
            lastStatus = status;
            node.status(status);
        }

        function logEvent(event, fields = {}) {
            if (!systemLogging) return;
            const tsNow = Date.now();
            const topic = fields.topic || fields.trigTopic || "";
            const restFields = { ...fields };
            delete restFields.topic;
            delete restFields.trigTopic;
            const parts = Object.entries(restFields).map(([k, v]) => `${k}=${v}`);
            const line = `[measure-delay] ${event}${topic ? ` ${topic}` : ""}${parts.length ? ` ${parts.join(" ")}` : ""} ${ts.formatLogSuffix({ nrMs: tsNow })}`;
            const statusKeep = lastStatus;
            const writeLog = node._uniflexOrigLog || node.log.bind(node);
            setImmediate(() => {
                try {
                    writeLog(line);
                } catch (_) {}
                if (statusKeep) {
                    node.status(statusKeep);
                }
            });
        }

        const badge = {
            armed: () => {
                if (Number.isFinite(lastMeasuredMs)) {
                    applyStatus({
                        fill: "blue",
                        shape: "ring",
                        text: `Waiting: ${trigTopic} -> ${partTopic || "any"}, last ${lastMeasuredWasLate ? "late" : "ok"} ${lastMeasuredMs}ms`
                    });
                } else {
                    applyStatus({
                        fill: "blue",
                        shape: "dot",
                        text: `Waiting: ${trigTopic} -> ${partTopic || "any"}`
                    });
                }
            },
            ok: (ms, tv, pv) => {
                const text =
                    responseType === "any_change"
                        ? `Ok: ${trigTopic}=${jsonShort(tv)} -> ${partTopic || "any"}=${jsonShort(pv)} in ${ms}ms`
                        : `Ok: ${trigTopic}=${partTopic || "any"}=${jsonShort(pv)} in ${ms}ms`;
                applyStatus({ fill: "green", shape: "dot", text });
            },
            okLate: (ms, tv, pv) => {
                const text =
                    responseType === "any_change"
                        ? `Late: ${trigTopic}=${jsonShort(tv)} -> ${partTopic || "any"}=${jsonShort(pv)} in ${ms}ms`
                        : `Late: ${trigTopic}=${partTopic || "any"}=${jsonShort(pv)} in ${ms}ms`;
                applyStatus({ fill: "yellow", shape: "dot", text });
            },
            mismatch: (tv, pv) =>
                applyStatus({
                    fill: "red",
                    shape: "ring",
                    text: `Mismatch: ${trigTopic}=${jsonShort(tv)}, ${partTopic || "any"}=${jsonShort(pv)}`
                }),
            tout: (tv, pv) =>
                applyStatus({
                    fill: "red",
                    shape: "ring",
                    text: `Timeout: ${trigTopic}=${jsonShort(tv)}, ${partTopic || "any"}=${jsonShort(pv)} in ${timeoutMs}ms`
                })
        };

        function reset() {
            armed = false;
            timedOut = false;
            refVal = undefined;
            partnerValAtArm = undefined;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }

        function startWaiting(triggerValue) {
            if (triggerOnChangeOnly && hasLastArmedTrigger && compareValues(triggerValue, lastArmedTrigger)) {
                return;
            }
            reset();
            armed = true;
            refVal = triggerValue;
            partnerValAtArm = lastPartner;
            lastArmedTrigger = triggerValue;
            hasLastArmedTrigger = true;
            tStart = Date.now();

            timer = setTimeout(() => {
                timedOut = true; // mark as timed out but keep waiting
                if (!suppressTimeoutMessage) {
                    badge.tout(refVal, lastPartner);
                    node.send({
                        error: "timeout",
                        ms: timeoutMs,
                        trigger: refVal,
                        partner: lastPartner
                    });
                    logEvent("timeout", {
                        topic: trigTopic,
                        trigger: jsonShort(refVal),
                        partner: jsonShort(lastPartner),
                        timeoutMs
                    });
                }

                // Don't reset here - keep waiting for late response
            }, timeoutMs);

            badge.armed();
            logEvent("trigger", { topic: trigTopic, trigger: jsonShort(triggerValue) });
        }

        // Main message handler
        node.on("input", (msg) => {
            if (!("payload" in msg)) return; // ignore empty msgs

            const topic = msg.topic || "";
            const val = msg.payload;
            const sameTopicMode = !!partTopic && partTopic === trigTopic;

            // Recognise partner messages and remember value
            const partnerHit = sameTopicMode ? topic === trigTopic : (!partTopic && topic !== trigTopic) || (partTopic && topic === partTopic);
            if (partnerHit) lastPartner = val;

            // Partner message while armed (or after timeout)
            if (partnerHit && armed) {
                const elapsedMs = Date.now() - tStart;

                // Same-topic mode: timeout is the cycle delimiter.
                // If a message arrives after timeout window, treat it as a new trigger.
                if (sameTopicMode && elapsedMs > timeoutMs) {
                    startWaiting(val);
                    return;
                }

                if (partnerMatches(val, refVal)) {
                    const ms = elapsedMs;
                    const matchFields = {
                        topic,
                        trigger: jsonShort(refVal),
                        value: jsonShort(val),
                        ms,
                        ...(timedOut ? { late: 1 } : {})
                    };

                    if (timedOut) {
                        lastMeasuredMs = ms;
                        lastMeasuredWasLate = true;
                        badge.okLate(ms, refVal, val);
                    } else {
                        lastMeasuredMs = ms;
                        lastMeasuredWasLate = false;
                        badge.ok(ms, refVal, val);
                    }
                    reset();
                    node.send({
                        ok: true,
                        late: !!timedOut,
                        ms,
                        trigger: refVal,
                        partner: val,
                        value: val
                    });
                    logEvent("response_match", matchFields);
                } else if (responseType === "exact" && compareValues(val, partnerValAtArm)) {
                    // Partner not updated yet (e.g. lamp still at old DO while DI switch changed)
                    badge.armed();
                } else {
                    badge.mismatch(refVal, val);
                    logEvent("response_mismatch", {
                        topic,
                        trigger: jsonShort(refVal),
                        response: jsonShort(val),
                        partnerAtArm: jsonShort(partnerValAtArm),
                        elapsedMs
                    });
                }

                return;
            }

            // Trigger message
            if (topic === trigTopic) {
                startWaiting(val);
                return;
            }
        });

        node.on("close", () => {
            reset();
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-measure-delay", DelayedCompareNode);
};
