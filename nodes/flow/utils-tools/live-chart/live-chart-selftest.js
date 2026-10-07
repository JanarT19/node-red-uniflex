"use strict";

const assert = require("assert");
const core = require("./live-chart-core.js");

function sourceFixture() {
    return {
        mappings: [
            { keyNameSelect: "TEMPW", dataType: "value", index: 1, topic: "room.temp" },
            { keyNameSelect: "TEMPW", dataType: "value", index: 2, topic: "supply.temp" },
            { keyNameSelect: "POWERW", dataType: "value", index: 1, topic: "heater.power" },
            { keyNameSelect: "TEMPW", dataType: "status", topic: "room.status" }
        ],
        controller: {
            services: {
                TEMPW: { servicename: "Temperature", out_unit: "C", desc: ["Room", "Supply"] },
                POWERW: { servicename: "Power", out_unit: "kW" }
            },
            channels: {
                TEMPW: {
                    1: { desc: "Room" },
                    2: { desc: "Supply" }
                },
                POWERW: {
                    1: { desc: "Heater" }
                }
            }
        }
    };
}

function expectError(fn, fragment) {
    assert.throws(fn, (error) => error.message.includes(fragment));
}

function testCatalogAndUnits() {
    const catalog = core.buildCatalog(sourceFixture());
    assert.deepStrictEqual(
        catalog.map((item) => [item.topic, item.unit]),
        [
            ["heater.power", "kW"],
            ["room.temp", "C"],
            ["supply.temp", "C"]
        ]
    );
    assert.strictEqual(core.normalizeUnit(" _ "), "_");
    assert.strictEqual(core.normalizeUnit(" kW "), "kW");

    const valid = core.validateSettings(
        {
            refreshSeconds: 5,
            timespanMinutes: 10,
            selected: [
                { topic: "room.temp", axis: "left" },
                { topic: "supply.temp", axis: "left" },
                { topic: "heater.power", axis: "right" }
            ]
        },
        catalog
    );
    assert.strictEqual(valid.selected.length, 3);
    assert.deepStrictEqual(valid.axisStyles, { left: "line", right: "area" });

    const styled = core.validateSettings(
        {
            refreshSeconds: 5,
            timespanMinutes: 10,
            selected: [],
            axisStyles: { left: "area", right: "stacked" }
        },
        catalog
    );
    assert.deepStrictEqual(styled.axisStyles, { left: "area", right: "stacked" });
    const partiallyStyled = core.validateSettings({ axisStyles: { left: "line" } }, catalog, styled);
    assert.deepStrictEqual(partiallyStyled.axisStyles, { left: "line", right: "stacked" });
    expectError(
        () =>
            core.validateSettings(
                {
                    refreshSeconds: 5,
                    timespanMinutes: 10,
                    selected: [],
                    axisStyles: { left: "bars", right: "line" }
                },
                catalog
            ),
        "Unsupported left axis style"
    );

    expectError(
        () =>
            core.validateSettings(
                {
                    refreshSeconds: 5,
                    timespanMinutes: 10,
                    selected: [
                        { topic: "room.temp", axis: "left" },
                        { topic: "heater.power", axis: "left" }
                    ]
                },
                catalog
            ),
        "left axis already uses unit"
    );
    expectError(
        () =>
            core.validateSettings(
                {
                    refreshSeconds: 5,
                    timespanMinutes: 10,
                    selected: [
                        { topic: "room.temp", axis: "left" },
                        { topic: "supply.temp", axis: "right" }
                    ]
                },
                catalog
            ),
        "must use different units"
    );
}

function testInputNormalization() {
    const allowed = new Set(["room.temp", "heater.power"]);
    assert.deepStrictEqual(core.normalizeInput({ topic: "room.temp", payload: "21.5" }, allowed), [{ topic: "room.temp", value: 21.5 }]);
    assert.deepStrictEqual(core.normalizeInput({ payload: { "room.temp": 22, "heater.power": 3.4, ignored: 1 } }, allowed), [
        { topic: "room.temp", value: 22 },
        { topic: "heater.power", value: 3.4 }
    ]);
    assert.deepStrictEqual(core.normalizeInput({ topic: "room.temp", payload: null }, allowed), [{ topic: "room.temp", value: null }]);
}

function testSettingsRestore() {
    const catalog = core.buildCatalog(sourceFixture());
    const restored = core.restoreSettings(
        {
            refreshSeconds: 999,
            timespanMinutes: 30,
            axisStyles: { left: "bars", right: "stacked" },
            selected: [
                { topic: "room.temp", axis: "left" },
                { topic: "removed.topic", axis: "left" },
                { topic: "supply.temp", axis: "right" },
                { topic: "heater.power", axis: "right" }
            ]
        },
        catalog
    );
    assert.strictEqual(restored.refreshSeconds, 5);
    assert.strictEqual(restored.timespanMinutes, 30);
    assert.deepStrictEqual(restored.axisStyles, { left: "line", right: "stacked" });
    assert.deepStrictEqual(restored.selected, [
        { topic: "room.temp", axis: "left" },
        { topic: "heater.power", axis: "right" }
    ]);
    assert.ok(core.settingsEqual(restored, { ...restored }));
    assert.ok(!core.settingsEqual(restored, { ...restored, timespanMinutes: 15 }));

    const sourceWithoutMetadata = sourceFixture();
    sourceWithoutMetadata.controller.services = {};
    sourceWithoutMetadata.controller.channels = {};
    const catalogWithoutMetadata = core.buildCatalog(sourceWithoutMetadata);
    const mixedAxes = {
        refreshSeconds: 5,
        timespanMinutes: 10,
        axisStyles: { left: "line", right: "area" },
        selected: [
            { topic: "heater.power", axis: "right" },
            { topic: "room.temp", axis: "left" }
        ]
    };
    const prematureRestore = core.restoreSettings(mixedAxes, catalogWithoutMetadata);
    assert.deepStrictEqual(prematureRestore.selected, [{ topic: "heater.power", axis: "right" }]);
    const structuralRestore = core.restoreSettings(mixedAxes, catalogWithoutMetadata, undefined, { validateUnits: false });
    assert.deepStrictEqual(structuralRestore.selected, mixedAxes.selected);
    const completedRestore = core.restoreSettings(structuralRestore, catalog);
    assert.deepStrictEqual(completedRestore.selected, mixedAxes.selected);
}

function testSlidingBuffersAndCleanup() {
    const buffers = new core.SlidingBuffers(3);
    buffers.append("room.temp", 1000, 20, 0);
    buffers.append("room.temp", 2000, 21, 0);
    buffers.append("room.temp", 3000, 22, 0);
    buffers.append("room.temp", 4000, 23, 0);
    buffers.append("heater.power", 4000, 4, 0);

    assert.deepStrictEqual(buffers.snapshot(2500, ["room.temp"]), {
        "room.temp": [
            [3000, 22],
            [4000, 23]
        ]
    });
    assert.strictEqual(buffers.pointCount(), 2);
    buffers.clear();
    assert.strictEqual(buffers.pointCount(), 0);

    const manyPoints = Array.from({ length: 100 }, (_, index) => [index, index === 51 ? 999 : index]);
    const reduced = core.decimateMinMax(manyPoints, 20);
    assert.ok(reduced.length <= 20);
    assert.ok(reduced.some((point) => point[1] === 999));
}

function testHeartbeatTimeout() {
    assert.strictEqual(core.heartbeatTimeoutMs(1), 15000);
    assert.strictEqual(core.heartbeatTimeoutMs(5), 15000);
    assert.strictEqual(core.heartbeatTimeoutMs(30), 90000);
}

testCatalogAndUnits();
testInputNormalization();
testSettingsRestore();
testSlidingBuffersAndCleanup();
testHeartbeatTimeout();
console.log("live-chart self-test: OK");
