// Shared PI controller helper with persistence support
// Persistence dir is provided by the caller via setPersistenceFile()

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function createPI(config) {
    const fs = require("fs");
    const path = require("path");

    const Kp = Number(config?.Kp ?? 1);
    const invert = !!config?.invert;
    const outClampLow = Number(config?.outClampLow ?? 0);
    const outClampHigh = Number(config?.outClampHigh ?? 1);

    const hasIi = config?.Ii !== undefined && config?.Ii !== null && !isNaN(Number(config.Ii));
    const Ii = hasIi ? Number(config.Ii) : 0;
    const Ki = !hasIi ? Number(config?.Ki ?? 0) : 0;

    let integral = (outClampLow + outClampHigh) / 2; // sensible preload
    let refSampleSec = Number(config?.refSampleSec || 0) || 0;

    // persistence
    let persistenceMode = "off"; // 'off' | 'external' | 'every'
    let persistenceFile = null;
    let lastSave = 0;
    const THROTTLE_MS = 30000;

    let lastNowSec = null;
    function dtFrom(arg) {
        if (typeof arg === "number") return Math.max(0, Number(arg) || 0);
        if (arg && typeof arg === "object") {
            if (arg.dtSec != null) return Math.max(0, Number(arg.dtSec) || 0);
            if (arg.now != null) {
                const now = Number(arg.now) || 0;
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

    function shouldAutoSave() {
        if (persistenceMode !== "every") return false;
        const now = Date.now();
        return now - lastSave >= THROTTLE_MS;
    }

    function saveState() {
        if (!persistenceFile) return;
        try {
            const dir = path.dirname(persistenceFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const state = {
                integral,
                timestamp: Date.now(),
                config: { Kp, Ii, Ki, invert, outClampLow, outClampHigh, refSampleSec }
            };
            fs.writeFileSync(persistenceFile, JSON.stringify(state, null, 2));
        } catch (e) {
            console.warn(`[pi-core] save failed ${persistenceFile}: ${e.message}`);
        }
    }

    function loadState() {
        if (!persistenceFile) return false;
        try {
            if (!require("fs").existsSync(persistenceFile)) return false;
            const raw = require("fs").readFileSync(persistenceFile, "utf8");
            const s = JSON.parse(raw);
            if (typeof s.integral === "number") {
                integral = s.integral;
                console.log(`[pi-core] preload from ${persistenceFile}: I=${integral.toFixed(4)}`);
                return true;
            }
        } catch (e) {
            console.warn(`[pi-core] load failed ${persistenceFile}: ${e.message}`);
        }
        return false;
    }

    function step(error, dtOrOpts) {
        const e = invert ? -Number(error) : Number(error);
        const P = Kp * e;
        const dt = dtFrom(dtOrOpts);

        if (dt > 0) {
            if (hasIi) {
                const base = refSampleSec > 0 ? refSampleSec : 60;
                const scale = dt / base;
                integral += Ii * e * scale;
            } else {
                integral += Ki * e * dt;
            }
        }

        let u = P + integral;
        const c = clamp(u, outClampLow, outClampHigh);
        if (u !== c) {
            integral = c - P; // anti-windup
            u = c;
        }

        if (shouldAutoSave()) {
            lastSave = Date.now();
            saveState();
        }
        return u;
    }

    function setReferenceSample(sec) {
        refSampleSec = Math.max(0, Number(sec) || 0);
    }
    function reset() {
        integral = 0;
    }
    function getIntegral() {
        return integral;
    }
    function setIntegral(v) {
        integral = Number(v) || 0;
    }
    function setPersistenceMode(mode) {
        persistenceMode = mode === "every" || mode === "external" ? mode : "off";
        if (persistenceMode !== "off" && persistenceFile) loadState();
    }
    function setPersistenceFile(file) {
        persistenceFile = file;
        if (persistenceMode !== "off") loadState();
    }

    console.log(`[pi-core] created Kp=${Kp} Ii=${Ii} Ki=${Ki} clamp=[${outClampLow},${outClampHigh}]`);
    return {
        step,
        reset,
        setReferenceSample,
        getIntegral,
        setIntegral,
        saveState,
        loadState,
        setPersistenceMode,
        setPersistenceFile
    };
}

module.exports = { createPI };
