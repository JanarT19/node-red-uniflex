// marketplan-processor.js
// Computes FCR setpoint delta (kW) from grid frequency error and calendar MW caps.

const MARKETPLAN_PROCESSOR_VERSION = "1.3.0";
const FCR_N_BAND_HZ = 0.1; // Nordic Table 1: FCR-N band 49.9 - 50.1 Hz
const FCR_N_FULL_SCALE_HZ = 0.1; // Nordic: full FCR-N at +/- 0.1 Hz from 50.0
const FCR_D_FULL_SCALE_HZ = 0.4; // Nordic: full FCR-D over 0.4 Hz beyond band edge
const SWITCH_RETURN_DELAY_MS = 15000; // Nordic Section 3.6.1 recommended 15 s
const http = require("http");
const fs = require("fs");
const path = require("path");
const ts = require("../../core/lib/timestamp.js");

module.exports = function (RED) {
    function MarketplanProcessorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "";
        node.enableDebug = config.enableDebug === true;

        node.freqErrorTopic = (config.freqErrorTopic || "FERV.1").trim();
        node.outputTopic = resolveOutputTopic(config);

        node.calendarHost = (config.calendarHost || "localhost").trim();
        node.calendarPort = Number(config.calendarPort ?? 80);
        node.capRefreshSec = Math.max(5, Number(config.capRefreshSec ?? 30));

        node.modelMode = (config.modelMode || "sum").trim();

        node.testMode = config.testMode === true;
        node.testSweepHz = Math.max(0.01, Number(config.testSweepHz ?? 0.5));
        node.testStepHz = Math.max(0.001, Number(config.testStepHz ?? 0.05));
        node.testDwellMs = Math.max(0, Number(config.testDwellMs ?? 0));
        node.testCsvPath = (config.testCsvPath || "").trim();
        node.testTriggerTopic = (config.testTriggerTopic || "marketplan/test").trim();

        node.services = parseServices(config.services);

        const tag = `[marketplan:${node.name || "unnamed"}]`;
        let freqErrorHz = null;
        let lastOutKw = null;
        const capCache = {}; // capTitle -> { mw, ts }
        let capRefreshInFlight = false;
        let testSweepTimer = null;
        let testSweepActive = false;
        let switchProduct = "fcrn";
        let switchReturnTimer = null;

        function clearSwitchReturnTimer() {
            if (switchReturnTimer) {
                clearTimeout(switchReturnTimer);
                switchReturnTimer = null;
            }
        }

        function fullScaleHz(serviceType) {
            if (serviceType === "fcrd_up" || serviceType === "fcrd_down") {
                return FCR_D_FULL_SCALE_HZ;
            }
            return FCR_N_FULL_SCALE_HZ;
        }

        function switchTypesInstant(errHz) {
            if (Math.abs(errHz) <= FCR_N_BAND_HZ) return ["fcrn"];
            if (errHz < -FCR_N_BAND_HZ) return ["fcrd_up"];
            return ["fcrd_down"];
        }

        function updateSwitchState(errHz) {
            if (node.modelMode !== "switch" || !Number.isFinite(errHz)) return;
            if (Math.abs(errHz) > FCR_N_BAND_HZ) {
                clearSwitchReturnTimer();
                switchProduct = errHz < -FCR_N_BAND_HZ ? "fcrd_up" : "fcrd_down";
                return;
            }
            if (switchProduct === "fcrn") return;
            if (!switchReturnTimer) {
                switchReturnTimer = setTimeout(() => {
                    switchProduct = "fcrn";
                    switchReturnTimer = null;
                    if (Number.isFinite(freqErrorHz)) {
                        publishOutput(function (m) { node.send(m); });
                    }
                }, SWITCH_RETURN_DELAY_MS);
            }
        }

        function activeSwitchTypes(errHz) {
            if (testSweepActive) return switchTypesInstant(errHz);
            updateSwitchState(errHz);
            return [switchProduct];
        }

        function dbg(msg) {
            if (node.enableDebug) node.log(`${tag} ${msg}`);
        }

        function logState(msg) {
            node.log(`${tag} ${msg}`);
        }

        function parseServices(raw) {
            if (Array.isArray(raw)) return raw.filter(Boolean);
            if (typeof raw === "string" && raw.trim()) {
                try {
                    const parsed = JSON.parse(raw);
                    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
                } catch (e) {
                    return [];
                }
            }
            return [];
        }

        function resolveOutputTopic(cfg) {
            const direct = (cfg.outputTopic || "").trim();
            if (direct) return direct;
            const legacy = (cfg.outTopic || "").trim();
            if (!legacy) return "SDV.1";
            if (/\.\d+$/.test(legacy)) return legacy;
            const member = Math.max(1, parseInt(cfg.outMember, 10) || 1);
            return `${legacy}.${member}`;
        }

        function httpGet(reqPath) {
            return new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: node.calendarHost,
                    port: node.calendarPort,
                    path: reqPath,
                    method: "GET",
                    timeout: 5000
                }, (res) => {
                    let data = "";
                    res.on("data", (chunk) => { data += chunk; });
                    res.on("end", () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(new Error(`JSON parse error: ${e.message}`));
                            }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}`));
                        }
                    });
                });
                req.on("error", reject);
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("timeout"));
                });
                req.end();
            });
        }

        async function queryCapMw(title) {
            if (!title) return null;
            try {
                const checkPath = `/calendar?title=${encodeURIComponent(title)}&check=true`;
                const checkData = await httpGet(checkPath);
                if (checkData && checkData.value !== undefined && checkData.value !== null) {
                    const v = Number(checkData.value);
                    if (Number.isFinite(v)) return v;
                }
            } catch (e) {
                dbg(`check=true failed for ${title}: ${e.message}`);
            }

            const now = Math.floor(Date.now() / 1000);
            const start = now - 7 * 24 * 3600;
            const end = now + 3600;
            const reqPath = `/calendar?title=${encodeURIComponent(title)}&start=${start}&end=${end}`;
            try {
                const data = await httpGet(reqPath);
                if (!Array.isArray(data) || data.length === 0) return null;
                const sorted = data
                    .filter((p) => p.timestamp <= now)
                    .sort((a, b) => b.timestamp - a.timestamp);
                if (sorted.length === 0) return null;
                const v = Number(sorted[0].value);
                return Number.isFinite(v) ? v : null;
            } catch (e) {
                dbg(`range query failed for ${title}: ${e.message}`);
                return null;
            }
        }

        async function refreshCaps(reason) {
            if (capRefreshInFlight) return;
            capRefreshInFlight = true;
            try {
                for (const svc of node.services) {
                    const title = (svc.capTitle || "").trim();
                    if (!title) continue;
                    const mw = await queryCapMw(title);
                    capCache[title] = { mw, ts: Date.now() };
                    dbg(`cap ${title}=${mw == null ? "n/a" : mw.toFixed(3)} MW (${reason})`);
                }
            } finally {
                capRefreshInFlight = false;
            }
        }

        function getCapMw(title) {
            const entry = capCache[title];
            if (!entry || entry.mw == null) return null;
            return entry.mw;
        }

        function fcrnContribution(errHz, capMw, maxErrorHz) {
            if (!Number.isFinite(errHz) || !Number.isFinite(capMw) || capMw <= 0) return 0;
            if (!Number.isFinite(maxErrorHz) || maxErrorHz <= 0) return 0;
            const capKw = capMw * 1000;
            const absErr = Math.abs(errHz);
            const ratio = Math.min(absErr / maxErrorHz, 1);
            return -Math.sign(errHz) * ratio * capKw;
        }

        function fcrdUpContribution(errHz, capMw, maxErrorHz, bandHz) {
            if (!Number.isFinite(errHz) || !Number.isFinite(capMw) || capMw <= 0) return 0;
            if (!Number.isFinite(maxErrorHz) || maxErrorHz <= 0) return 0;
            if (errHz >= -bandHz) return 0;
            const dErr = Math.abs(errHz) - bandHz;
            if (dErr <= 0) return 0;
            const capKw = capMw * 1000;
            const ratio = Math.min(dErr / maxErrorHz, 1);
            return ratio * capKw;
        }

        function fcrdDownContribution(errHz, capMw, maxErrorHz, bandHz) {
            if (!Number.isFinite(errHz) || !Number.isFinite(capMw) || capMw <= 0) return 0;
            if (!Number.isFinite(maxErrorHz) || maxErrorHz <= 0) return 0;
            if (errHz <= bandHz) return 0;
            const dErr = errHz - bandHz;
            if (dErr <= 0) return 0;
            const capKw = capMw * 1000;
            const ratio = Math.min(dErr / maxErrorHz, 1);
            return -ratio * capKw;
        }

        function serviceContributionSum(serviceType, errHz, capMw, bandHz) {
            const maxErrorHz = fullScaleHz(serviceType);
            if (serviceType === "fcrd_up") {
                return fcrdUpContribution(errHz, capMw, maxErrorHz, bandHz);
            }
            if (serviceType === "fcrd_down") {
                return fcrdDownContribution(errHz, capMw, maxErrorHz, bandHz);
            }
            return fcrnContribution(errHz, capMw, maxErrorHz);
        }

        function computeBreakdown(errHz) {
            const empty = {
                totalKw: null,
                contribs: { fcrn: 0, fcrd_up: 0, fcrd_down: 0 },
                caps: { fcrn: null, fcrd_up: null, fcrd_down: null }
            };
            if (!Number.isFinite(errHz)) return empty;

            const bandHz = FCR_N_BAND_HZ;
            const contribs = { fcrn: 0, fcrd_up: 0, fcrd_down: 0 };
            const caps = { fcrn: null, fcrd_up: null, fcrd_down: null };
            const activeTypes = node.modelMode === "switch"
                ? activeSwitchTypes(errHz)
                : ["fcrn", "fcrd_up", "fcrd_down"];

            for (const svc of node.services) {
                const capTitle = (svc.capTitle || "").trim();
                const capMw = getCapMw(capTitle);
                const type = String(svc.serviceType || "fcrn").trim();
                if (caps[type] !== undefined && caps[type] == null && capMw != null) {
                    caps[type] = capMw;
                }
                if (!activeTypes.includes(type)) continue;
                const kw = serviceContributionSum(type, errHz, capMw, bandHz);
                if (contribs[type] !== undefined) contribs[type] += kw;
            }

            const totalKw = contribs.fcrn + contribs.fcrd_up + contribs.fcrd_down;
            return { totalKw, contribs, caps };
        }

        function computeOutputKw() {
            return computeBreakdown(freqErrorHz).totalKw;
        }

        function updateStatus(outKw, extra) {
            if (!Number.isFinite(freqErrorHz)) {
                node.status({ fill: "grey", shape: "ring", text: "waiting for frequency error" });
                return;
            }
            const outTxt = Number.isFinite(outKw) ? `${outKw.toFixed(1)} kW` : "n/a";
            const suffix = extra ? ` ${extra}` : "";
            node.status({
                fill: testSweepActive ? "yellow" : (Math.abs(outKw || 0) > 0.01 ? "green" : "blue"),
                shape: "dot",
                text: `${node.modelMode} ferr=${freqErrorHz >= 0 ? "+" : ""}${freqErrorHz.toFixed(3)} out=${outTxt}${suffix}`
            });
        }

        function publishOutput(send, forceLog) {
            const breakdown = computeBreakdown(freqErrorHz);
            const outKw = breakdown.totalKw;
            updateStatus(outKw);
            if (!Number.isFinite(outKw)) return breakdown;

            const topic = node.outputTopic;
            const payload = parseFloat(outKw.toFixed(2));
            const changed = forceLog || lastOutKw === null || Math.abs(payload - lastOutKw) >= 0.01;
            if (changed && !testSweepActive) {
                logState(`SDV ${payload >= 0 ? "+" : ""}${payload.toFixed(2)} kW (ferr=${freqErrorHz.toFixed(3)} Hz)`);
                lastOutKw = payload;
            }
            send({ topic, payload });
            return breakdown;
        }

        function csvEscape(val) {
            const s = val == null ? "" : String(val);
            if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        }

        function capMwTag(mw) {
            return mw == null || !Number.isFinite(mw) ? "na" : Number(mw).toFixed(3);
        }

        function snapshotCapsMw() {
            const caps = { fcrn: null, fcrd_up: null, fcrd_down: null };
            for (const svc of node.services) {
                const type = String(svc.serviceType || "fcrn").trim();
                const capMw = getCapMw((svc.capTitle || "").trim());
                if (caps[type] !== undefined && caps[type] == null && capMw != null) {
                    caps[type] = capMw;
                }
            }
            return caps;
        }

        function buildTestCsvPath(basePath) {
            const caps = snapshotCapsMw();
            const ext = path.extname(basePath) || ".csv";
            const stem = basePath.slice(0, basePath.length - ext.length);
            const tag = [
                node.modelMode,
                `N${capMwTag(caps.fcrn)}`,
                `Du${capMwTag(caps.fcrd_up)}`,
                `Dd${capMwTag(caps.fcrd_down)}`
            ].join("_");
            return `${stem}_${tag}${ext}`;
        }

        function buildCsv(rows) {
            const header = [
                "ferr_hz",
                "sdv_kw",
                "fcrn_kw",
                "fcrd_up_kw",
                "fcrd_down_kw"
            ];
            const lines = [header.join(",")];
            for (const row of rows) {
                lines.push([
                    row.ferrHz.toFixed(4),
                    row.sdvKw.toFixed(2),
                    row.fcrnKw.toFixed(2),
                    row.fcrdUpKw.toFixed(2),
                    row.fcrdDownKw.toFixed(2)
                ].map(csvEscape).join(","));
            }
            return lines.join("\n") + "\n";
        }

        function stopTestSweep() {
            if (testSweepTimer) {
                clearTimeout(testSweepTimer);
                testSweepTimer = null;
            }
            testSweepActive = false;
        }

        function writeCsvFile(csvText, filePath) {
            if (!filePath) return null;
            const dir = path.dirname(filePath);
            if (dir && dir !== "." && !fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, csvText, "utf8");
            return filePath;
        }

        async function runTestSweep(send) {
            if (testSweepActive) {
                logState("test sweep already running, skipped");
                return;
            }
            send = send || function (m) { node.send(m); };
            stopTestSweep();
            testSweepActive = true;
            updateStatus(computeOutputKw(), "test...");

            try {
                await refreshCaps("test");
            } catch (e) {
                logState(`test cap refresh failed: ${e.message}`);
            }

            const rows = [];
            const steps = [];
            const sweep = node.testSweepHz;
            const step = node.testStepHz;
            for (let f = -sweep; f <= sweep + step * 0.001; f += step) {
                steps.push(parseFloat(f.toFixed(4)));
            }

            let idx = 0;

            function recordStep(ferr) {
                freqErrorHz = ferr;
                const breakdown = publishOutput(send, false);
                rows.push({
                    ferrHz: ferr,
                    sdvKw: breakdown.totalKw,
                    fcrnKw: breakdown.contribs.fcrn,
                    fcrdUpKw: breakdown.contribs.fcrd_up,
                    fcrdDownKw: breakdown.contribs.fcrd_down
                });
                dbg(`test ferr=${ferr.toFixed(4)} sdv=${breakdown.totalKw.toFixed(2)} kW`);
            }

            function finishSweep() {
                testSweepActive = false;
                const csvText = buildCsv(rows);
                const caps = snapshotCapsMw();
                const filePath = node.testCsvPath
                    ? writeCsvFile(csvText, buildTestCsvPath(node.testCsvPath))
                    : null;
                logState(`test sweep done, ${rows.length} rows, model=${node.modelMode}, caps N=${capMwTag(caps.fcrn)} Du=${capMwTag(caps.fcrd_up)} Dd=${capMwTag(caps.fcrd_down)} MW`);
                if (filePath) {
                    logState(`test CSV written to ${filePath}`);
                } else {
                    logState("test CSV path not set, results not saved");
                }
                updateStatus(computeOutputKw());
            }

            function runStep() {
                if (idx >= steps.length) {
                    finishSweep();
                    return;
                }

                const ferr = steps[idx];
                recordStep(ferr);
                updateStatus(computeBreakdown(ferr).totalKw, `test ${idx + 1}/${steps.length}`);
                idx += 1;
                testSweepTimer = setTimeout(runStep, node.testDwellMs);
            }

            if (node.testDwellMs <= 0) {
                for (let i = 0; i < steps.length; i++) {
                    recordStep(steps[i]);
                }
                finishSweep();
            } else {
                runStep();
            }
        }

        node.on("input", (msg, send, done) => {
            send = send || function (m) { node.send(m); };
            const t = String(msg.topic || "").trim();

            if (t === node.testTriggerTopic || (node.testMode && msg.payload === "test")) {
                runTestSweep(send).catch((e) => {
                    stopTestSweep();
                    node.error(`${tag} test sweep failed: ${e.message}`, msg);
                });
                if (done) done();
                return;
            }

            if (!testSweepActive && t === node.freqErrorTopic) {
                const n = (msg.payload == null ? null : (Number.isFinite(Number(msg.payload)) ? Number(msg.payload) : null));
                if (n === null) {
                    if (done) done();
                    return;
                }
                freqErrorHz = n;
            }

            publishOutput(send);

            const oldest = Object.values(capCache).reduce((min, e) => {
                if (!e || !e.ts) return min;
                return min === 0 ? e.ts : Math.min(min, e.ts);
            }, 0);
            const cacheAgeMs = oldest > 0 ? Date.now() - oldest : Infinity;
            if (cacheAgeMs > node.capRefreshSec * 1000) {
                refreshCaps("input").then(() => publishOutput(send)).catch(() => {});
            }

            if (done) done();
        });

        refreshCaps("deploy").then(() => {
            updateStatus(computeOutputKw());
            if (node.testMode) {
                runTestSweep().catch((e) => {
                    stopTestSweep();
                    node.error(`${tag} test sweep failed: ${e.message}`);
                });
            }
        }).catch(() => {});

        const capTimer = setInterval(() => {
            refreshCaps("interval").catch(() => {});
        }, node.capRefreshSec * 1000);

        node.on("close", () => {
            clearInterval(capTimer);
            stopTestSweep();
            clearSwitchReturnTimer();
            node.status({});
        });

        node.log(`${tag} started v${MARKETPLAN_PROCESSOR_VERSION}, model=${node.modelMode}, services=${node.services.length}`);
    }

    RED.nodes.registerType("uniflex-marketplan-processor", MarketplanProcessorNode);
};
