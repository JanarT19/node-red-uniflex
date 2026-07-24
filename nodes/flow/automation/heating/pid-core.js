// Universal PID controller helper
// Supports Ii-mode for integral (per reference sample) and derivative-on-measurement Dd.
//
// Math:
//  P = Kp * e
//  I += Ii * e * (dt / refSampleSec)
//  D = -Dd * (y - yPrev) * (refSampleSec / dt)  [if y provided and dt>0]
//  u = clamp(P + I + D, low, high)
//  Anti-windup: when saturated, set I = u - P - D

function clamp(value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
}

function createPID(config) {
    const Kp = Number(config.Kp ?? 1.0);
    const invert = !!config.invert;
    const outClampLow = Number(config.outClampLow ?? 0);
    const outClampHigh = Number(config.outClampHigh ?? 1);

    const Ii = Number(config.Ii ?? 0);
    const Dd = Number(config.Dd ?? 0.0);

    let integral = 0;
    let refSampleSec = Number(config.refSampleSec || 0) || 0; // 0 => unset
    let lastNowSec = null;
    let lastY = null;

    function setReferenceSample(sec) {
        refSampleSec = Math.max(0, Number(sec) || 0);
    }

    function reset() {
        integral = 0;
        lastNowSec = null;
        lastY = null;
    }

    function getIntegral() {
        return integral;
    }

    function setIntegral(v) {
        integral = Number(v) || 0;
    }

    function resolveDtSec(dtOrOpts) {
        if (typeof dtOrOpts === "number") return Math.max(0, Number(dtOrOpts) || 0);

        if (dtOrOpts && typeof dtOrOpts === "object") {
            if (dtOrOpts.dtSec != null) return Math.max(0, Number(dtOrOpts.dtSec) || 0);

            if (dtOrOpts.now != null) {
                const now = Number(dtOrOpts.now) || 0;

                if (lastNowSec == null) {
                    lastNowSec = now;
                    return 0;
                }

                const d = Math.max(0, now - lastNowSec);
                lastNowSec = now;

                return d;
            }
        }

        return 0;
    }

    // step can be called as step(e, opts) or step({ e, y }, opts)
    function step(arg, dtOrOpts) {
        const hasObj = arg && typeof arg === "object" && !isFinite(arg);
        const e = invert ? -(hasObj ? Number(arg.e) : Number(arg)) : hasObj ? Number(arg.e) : Number(arg);
        const y = hasObj ? (arg.y != null ? Number(arg.y) : null) : null;
        const dtSec = resolveDtSec(dtOrOpts);

        const P = Kp * e;

        if (dtSec > 0) {
            const base = refSampleSec > 0 ? refSampleSec : 60; // default reference if unknown
            const scale = dtSec / base;
            integral += Ii * e * scale;
        }

        // Derivative on measurement (only if y provided and dt>0)
        let D = 0;
        if (Dd !== 0 && y != null && dtSec > 0) {
            if (lastY != null) {
                const base = refSampleSec > 0 ? refSampleSec : 60;
                const dy = y - lastY;
                // scale so that Dd is per reference sample
                D = -Dd * dy * (base / dtSec);
            }

            lastY = y;
        }

        let u = P + integral + D;
        const clamped = clamp(u, outClampLow, outClampHigh);
        if (u !== clamped) {
            integral = clamped - P - D;
            u = clamped;
        }

        return u;
    }

    return { step, reset, setReferenceSample, getIntegral, setIntegral };
}

module.exports = { createPID };
