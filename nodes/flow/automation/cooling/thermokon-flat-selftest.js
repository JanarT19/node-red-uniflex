#!/usr/bin/env node
"use strict";

/**
 * Isolated thermokon-flat test (flat 201 non-cooled).
 * Run:
 *   node /mnt/c/neeme/SWdev/pyapp/cursor/nodered/node-red-uniflex/nodes/flow/automation/cooling/thermokon-flat-selftest.js
 *
 * Does not touch write-data-streams or the controller.
 */

const path = require("path");
const { EventEmitter } = require("events");

const MODE_BATCH_MS = 20;
const FLUSH_WAIT_MS = MODE_BATCH_MS + 40;

const flat201Config = {
    id: "selftest-flat-201",
    type: "uniflex-thermokon-flat",
    name: "flat 201 selftest",
    flatType: "non-cooled-2",
    flatNumber: "201",
    forceTopic: "P2N201S.1",
    writeTopics: "WBN201W.1,WBN201W.2,WBN201W.3",
    modeTopics: "MBN201W.1,MBN201W.2,MBN201W.3",
    displayTopics: "E2N201W.1,E2N201W.2,E2N201W.3",
    setpointTopics: "TBN201W.2,TBN201W.4,TBN201W.6",
    setpointBankTopics: "SBN201W.1,SBN201W.2,SBN201W.3,SBN201W.4,SBN201W.5,SBN201W.6",
    pirTopics: "",
    pirZoneIndices: "",
    sanitaryWriteTopic: "",
    r340HoldSec: 65535,
    comfortPulseTopic: "",
    enableDebug: false
};

const flat209CooledConfig = {
    id: "selftest-flat-209",
    type: "uniflex-thermokon-flat",
    name: "flat 209 cooled selftest",
    flatType: "cooled-1",
    flatNumber: "209",
    forceTopic: "",
    writeTopics: "",
    modeTopics: "MAC209W.1,MAC209W.2",
    displayTopics: "E1C209W.1,E1C209W.2",
    setpointTopics: "TAC209W.2,TAC209W.4",
    setpointBankTopics: "SAC209W.1,SAC209W.2,SAC209W.3,SAC209W.4",
    pirTopics: "D1C209W.2",
    pirZoneIndices: "1",
    sanitaryWriteTopic: "WAC209W.1",
    r340HoldSec: 65535,
    comfortPulseTopic: "P1C209S.1",
    enableDebug: false
};

function lastEcoMember(node, topic) {
    const hits = node._send.filter((m) => m.topic === topic);
    if (hits.length === 0) {
        return null;
    }
    return hits[hits.length - 1].payload;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMockRed() {
    const globalStore = {};
    let NodeCtor = null;

    const RED = {
        nodes: {
            createNode(node, config) {
                Object.assign(node, config);
                node._send = [];
                node._warn = [];
                node._log = [];
                node.send = (msg) => {
                    if (Array.isArray(msg)) {
                        node._send.push(...msg);
                    } else {
                        node._send.push(msg);
                    }
                };
                node.warn = (...args) => node._warn.push(args.join(" "));
                node.log = (...args) => node._log.push(args.join(" "));
                node.status = () => {};
                const ctxMemory = {};
                const ctxFile = node._initialCtxFile ? Object.assign({}, node._initialCtxFile) : {};
                node.context = () => ({
                    get(key, store) {
                        if (store === "file") {
                            return ctxFile[key];
                        }
                        return ctxMemory[key];
                    },
                    set(key, val, store) {
                        if (store === "file") {
                            ctxFile[key] = val;
                        } else {
                            ctxMemory[key] = val;
                        }
                    },
                    global: {
                        get(key) {
                            return globalStore[key];
                        },
                        set(key, val) {
                            globalStore[key] = val;
                        }
                    }
                });
                node._ctxFile = ctxFile;
            },
            registerType(type, ctor) {
                NodeCtor = ctor;
            }
        },
        _NodeCtor: () => NodeCtor,
        globalStore
    };

    return RED;
}

function lastEcoArray(node) {
    const arr = node._send.filter((m) => m.topic === "E2N201W" && Array.isArray(m.payload));
    if (arr.length === 0) {
        return null;
    }
    return arr[arr.length - 1].payload;
}

function createFlatNode(RED, config, initialCtxFile) {
    const NodeCtor = RED._NodeCtor();
    const node = new EventEmitter();
    if (initialCtxFile) {
        node._initialCtxFile = initialCtxFile;
    }
    NodeCtor.call(node, config || flat201Config);
    return node;
}

function collectR514Writes(node) {
    const out = {};
    for (let i = 0; i < node._send.length; i++) {
        const m = node._send[i];
        if (!m || typeof m !== "object") {
            continue;
        }
        if (m.topic && /^W[AB][NC]\d+W\.\d+$/.test(m.topic)) {
            out[m.topic] = m.payload;
        }
        const keys = Object.keys(m);
        for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if (/^W[AB][NC]\d+W\.\d+$/.test(key)) {
                out[key] = m[key];
            }
        }
    }
    return out;
}

async function seedComfort201(n) {
    n.emit("input", {
        topic: "MBN201W.1",
        payload: 2,
        streamValues: [2, 2, 2],
        controller: { uniqueId: "local" }
    });
    await sleep(FLUSH_WAIT_MS);
    n._send.length = 0;
}

async function runCase(name, fn) {
    process.stdout.write(`  ${name} ... `);
    try {
        await fn();
        console.log("OK");
        return true;
    } catch (err) {
        console.log("FAIL");
        console.error(`    ${err.message}`);
        return false;
    }
}

async function main() {
    const RED = buildMockRed();
    require(path.join(__dirname, "thermokon-flat.js"))(RED);

    let passed = 0;
    let failed = 0;

    console.log("thermokon-flat selftest (flat 201)");

    if (
        await runCase("M=[2,2,2] -> E=[0,0,0]", async () => {
            const n = createFlatNode(RED);
            n.emit("input", {
                topic: "MBN201W.1",
                payload: 2,
                streamValues: [2, 2, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const eco = lastEcoArray(n);
            if (!eco || eco.join(",") !== "0,0,0") {
                throw new Error(`expected [0,0,0], got ${eco ? eco.join(",") : "none"}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("force eco then M=[2,2,2] -> E=[0,0,0] (not stuck at 1)", async () => {
            const n = createFlatNode(RED);
            RED.globalStore.local_input_states = {
                MBN201W: { values: [18, 2, 2] }
            };
            n.emit("input", {
                topic: "P2N201S.1",
                payload: 1,
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            n.emit("input", {
                topic: "MBN201W.3",
                payload: 2,
                streamValues: [2, 2, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const eco = lastEcoArray(n);
            if (!eco || eco.join(",") !== "0,0,0") {
                throw new Error(`expected [0,0,0], got ${eco ? eco.join(",") : "none"}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("M=[18,2,2] -> E=[1,0,0]", async () => {
            const n = createFlatNode(RED);
            n.emit("input", {
                topic: "MBN201W.2",
                payload: 2,
                streamValues: [18, 2, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const eco = lastEcoArray(n);
            if (!eco || eco.join(",") !== "1,0,0") {
                throw new Error(`expected [1,0,0], got ${eco ? eco.join(",") : "none"}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("M=[18,18,18] -> E=[1,1,1]", async () => {
            const n = createFlatNode(RED);
            n.emit("input", {
                topic: "MBN201W.1",
                payload: 18,
                streamValues: [18, 18, 18],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const eco = lastEcoArray(n);
            if (!eco || eco.join(",") !== "1,1,1") {
                throw new Error(`expected [1,1,1], got ${eco ? eco.join(",") : "none"}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("cooled first PIR=0 -> E living eco (not comfort hold)", async () => {
            const n = createFlatNode(RED, flat209CooledConfig);
            n.emit("input", {
                topic: "MAC209W.2",
                payload: 2,
                streamValues: [18, 2],
                controller: { uniqueId: "local" }
            });
            n.emit("input", { topic: "D1C209W.2", payload: 0 });
            await sleep(FLUSH_WAIT_MS);
            const eco = lastEcoMember(n, "E1C209W.2");
            if (eco !== 1) {
                throw new Error(`expected E1C209W.2=1 (eco), got ${eco}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("cooled PIR hold restored from file context", async () => {
            const holdMs = Date.now() - 5000;
            const n = createFlatNode(RED, flat209CooledConfig, {
                pirHold: {
                    "D1C209W.2": { active: false, inactiveSince: holdMs }
                }
            });
            n.emit("input", {
                topic: "MAC209W.2",
                payload: 2,
                streamValues: [18, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const eco = lastEcoMember(n, "E1C209W.2");
            if (eco !== 0) {
                throw new Error(`expected E1C209W.2=0 (comfort hold), got ${eco}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("P1C209 comfort pulse -> E living comfort", async () => {
            const n = createFlatNode(RED, flat209CooledConfig);
            n.emit("input", {
                topic: "MAC209W.2",
                payload: 2,
                streamValues: [18, 2],
                controller: { uniqueId: "local" }
            });
            n.emit("input", { topic: "P1C209S.1", payload: 1 });
            await sleep(FLUSH_WAIT_MS);
            const eco = lastEcoMember(n, "E1C209W.2");
            if (eco !== 0) {
                throw new Error(`expected E1C209W.2=0 (comfort), got ${eco}`);
            }
            const clear = n._send.filter((m) => m.topic === "P1C209S.1" && m.payload === 0);
            if (clear.length > 0) {
                throw new Error("expected no immediate P1C clear");
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("P2N201 comfort pulse -> all W r514 2 and E all comfort", async () => {
            const n = createFlatNode(RED);
            n.emit("input", {
                topic: "MBN201W.1",
                payload: 2,
                streamValues: [2, 18, 18],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            n._send.length = 0;
            n.emit("input", {
                topic: "P2N201S.1",
                payload: 1,
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const w = collectR514Writes(n);
            if (w["WBN201W.1"] !== 2 || w["WBN201W.2"] !== 2 || w["WBN201W.3"] !== 2) {
                throw new Error(`expected all W=2, got ${JSON.stringify(w)}`);
            }
            const eco = lastEcoArray(n);
            if (!eco || eco.join(",") !== "0,0,0") {
                throw new Error(`expected E=[0,0,0] during pulse, got ${eco ? eco.join(",") : "none"}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("panel-sync living eco -> all W r514 18", async () => {
            const n = createFlatNode(RED);
            await seedComfort201(n);
            n.emit("input", {
                topic: "MBN201W.2",
                payload: 18,
                streamValues: [2, 18, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const w = collectR514Writes(n);
            if (w["WBN201W.1"] !== 18 || w["WBN201W.2"] !== 18 || w["WBN201W.3"] !== 18) {
                throw new Error(`expected all 18, got ${JSON.stringify(w)}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("panel-sync san comfort -> all W r514 2", async () => {
            const n = createFlatNode(RED);
            n.emit("input", {
                topic: "MBN201W.1",
                payload: 18,
                streamValues: [18, 18, 18],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            n._send.length = 0;
            n.emit("input", {
                topic: "MBN201W.1",
                payload: 2,
                streamValues: [2, 18, 18],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const w = collectR514Writes(n);
            if (w["WBN201W.1"] !== 2 || w["WBN201W.2"] !== 2 || w["WBN201W.3"] !== 2) {
                throw new Error(`expected all 2, got ${JSON.stringify(w)}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("cooled M change -> no W r514", async () => {
            const n = createFlatNode(RED, flat209CooledConfig);
            n.emit("input", {
                topic: "MAC209W.2",
                payload: 18,
                streamValues: [18, 18],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const w = collectR514Writes(n);
            if (Object.keys(w).length > 0) {
                throw new Error(`expected no W writes, got ${JSON.stringify(w)}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("panel-sync standby r277=0 -> W r514 18 on that zone", async () => {
            const n = createFlatNode(RED);
            await seedComfort201(n);
            n.emit("input", {
                topic: "MBN201W.2",
                payload: 0,
                streamValues: [2, 0, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const w = collectR514Writes(n);
            if (w["WBN201W.2"] !== 18) {
                throw new Error(`expected WBN201W.2=18 (standby fix), got ${JSON.stringify(w)}`);
            }
            if (w["WBN201W.1"] !== 18 || w["WBN201W.3"] !== 18) {
                throw new Error(`expected other zones 18, got ${JSON.stringify(w)}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    if (
        await runCase("panel-sync r277=18 already eco -> skip redundant W on that zone", async () => {
            const n = createFlatNode(RED);
            n.emit("input", {
                topic: "MBN201W.1",
                payload: 18,
                streamValues: [18, 2, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            n._send.length = 0;
            n.emit("input", {
                topic: "MBN201W.1",
                payload: 18,
                streamValues: [18, 2, 2],
                controller: { uniqueId: "local" }
            });
            await sleep(FLUSH_WAIT_MS);
            const w = collectR514Writes(n);
            if (w["WBN201W.1"] !== undefined) {
                throw new Error(`expected no write to already-eco zone, got ${JSON.stringify(w)}`);
            }
            n.emit("close");
        })
    ) {
        passed++;
    } else {
        failed++;
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
