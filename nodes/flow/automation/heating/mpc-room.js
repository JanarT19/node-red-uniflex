const ts = require("../../core/lib/timestamp.js");
// mpc-room.js - REDESIGNED
// MPC Room Layer: tick-driven floor setpoint generation with adaptive bias and load estimation
// Matches room-loop pattern for synchronization

module.exports = function (RED) {
    const NODE_VERSION = "2.0.0-redesigned"; // Tick-driven with adaptive bias and load estimation

    function MpcRoomNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // ---- CONFIG
        node.name = config.name || "";

        // Timing
        node.globalTickTopic = config.globalTickTopic || "";
        node.tickDelaySec = Number(config.tickDelaySec ?? 0);
        node.roomTickTopic = config.roomTickTopic || `heating/${node.name || "unknown"}/tick`;

        // Heating curve parameters (room-specific)
        const Tref = parseFloat(config.Tref) || 0;
        const a = parseFloat(config.hcOffset) || 26;
        const b = parseFloat(config.hcSlope) || 0.2;
        const k_e = parseFloat(config.k_e) || 0.5;
        const Tf_min = parseFloat(config.Tf_min) || 23;
        const Tf_max = parseFloat(config.Tf_max) || 29;

        // Comfort bands
        const bandL = parseFloat(config.band_low) || 0.2;
        const bandH = parseFloat(config.band_high) || 0.4;

        // Adaptive bias
        const enableAdaptiveBias = config.enableAdaptiveBias !== false; // default true
        const biasLearningRate = parseFloat(config.biasLearningRate) || 0.0001;
        const biasClamp = parseFloat(config.biasClamp) || 1.0;

        // Room parameters
        const floorArea = parseFloat(config.floorArea) || 0; // m²

        // Topics
        const tRoomTopic = config.tRoomTopic || "";
        const spRoomTopic = config.spRoomTopic || "";
        const tOutTopic = config.tOutTopic || "";
        const tsupplyTopic = config.tsupplyTopic || "";

        // Parse return topics (comma-separated or array)
        const rawTReturnList = Array.isArray(config.tReturnTopics) ? config.tReturnTopics : typeof config.tReturnTopics === "string" ? config.tReturnTopics.split(",") : [];
        const tReturnTopics = rawTReturnList.map((s) => (s || "").trim()).filter((s) => s.length > 0);

        // Output topics
        const tfSetOutTopic = config.tfSetOutTopic || "";
        const roomLoadEstOutTopic = config.roomLoadEstOutTopic || "";

        // ---- STATE
        let Ti = null;
        let Tset = null;
        let Tout = null;
        let Tsupply = null;
        const tReturnState = {};

        let Tf_bias = 0; // Adaptive bias (learned)

        let lastGlobalTickTs = null;
        let lastPeriodSec = null;

        // Log startup info with version
        node.log(
            `[mpc-room:${node.name}] *** VERSION ${NODE_VERSION} *** | ` +
                `tick: ${node.globalTickTopic} → ${node.roomTickTopic} (delay ${node.tickDelaySec}s) | ` +
                `curve: a=${a} b=${b} k_e=${k_e} | adaptive: ${enableAdaptiveBias ? "enabled" : "disabled"}`
        );

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        setStatus(`Ready - waiting for tick: ${node.globalTickTopic || "n/a"}`, "grey");

        // ---- Compute floor setpoint and room load estimate
        function computeAndPublish() {
            if (Ti == null || Tset == null) {
                setStatus(`Waiting inputs (${ts.formatStatus()})`, "grey");
                return;
            }

            // Use Tref if Tout not available
            const ToutUsed = Number.isFinite(Tout) ? Tout : Tref;

            // --- Floor setpoint calculation ---
            const e_room = Tset - Ti; // + => too cold

            // Heating curve base
            const Tf_base = a + b * (Tref - ToutUsed);

            // Trim from room error
            const Tf_trim = k_e * e_room;

            // Apply adaptive bias (learned offset)
            let Tf_set = Tf_base + Tf_trim + Tf_bias;

            // Clamp to limits
            if (Tf_set < Tf_min) Tf_set = Tf_min;
            if (Tf_set > Tf_max) Tf_set = Tf_max;

            // --- Adaptive bias learning ---
            if (enableAdaptiveBias && tReturnTopics.length > 0) {
                // Get average floor return temp
                const validReturns = Object.values(tReturnState).filter((t) => Number.isFinite(t));
                if (validReturns.length > 0) {
                    const Tf_actual = validReturns.reduce((sum, t) => sum + t, 0) / validReturns.length;

                    // If room error is small and persistent, adjust bias
                    // Only learn when not saturated at limits
                    const atLimit = Tf_set <= Tf_min || Tf_set >= Tf_max;
                    if (Math.abs(e_room) > 0.1 && Math.abs(e_room) < 2.0 && !atLimit) {
                        // Small persistent error → adjust bias
                        const bias_before = Tf_bias;
                        Tf_bias += biasLearningRate * e_room;

                        // Clamp bias
                        if (Tf_bias < -biasClamp) Tf_bias = -biasClamp;
                        if (Tf_bias > biasClamp) Tf_bias = biasClamp;

                        // Log learning events (every ~50 steps to avoid spam)
                        const bias_change = Tf_bias - bias_before;
                        if (Math.abs(Tf_bias) % 0.05 < Math.abs(bias_before) % 0.05 || Math.abs(Tf_bias) > 0.8) {
                            node.log(
                                `[mpc-room:${node.name}] Adaptive learning: e_room=${e_room.toFixed(2)}°C → bias=${Tf_bias.toFixed(3)}°C (Δ${bias_change >= 0 ? "+" : ""}${bias_change.toFixed(4)})`
                            );
                        }
                    }

                    // Safety: if floor temp way off setpoint, log warning
                    const Tf_error = Tf_actual - Tf_set;
                    if (Math.abs(Tf_error) > 3.0) {
                        node.warn(
                            `[mpc-room:${node.name}] Large floor error: Tf_actual=${Tf_actual.toFixed(1)}°C vs Tf_set=${Tf_set.toFixed(1)}°C (error=${Tf_error.toFixed(1)}°C)`
                        );
                    }
                }
            }

            // --- Room load estimate (always calculate if inputs available) ---
            // Purpose: Real-time relative weight for analytics or future MPC weighting
            // Note: mpc-house does NOT currently use this - it relies on its internal 2nd-order model
            // This is for monitoring/charting and understanding per-room energy consumption
            let room_load_est = null;
            if (Number.isFinite(Tsupply) && tReturnTopics.length > 0) {
                const validReturns = Object.values(tReturnState).filter((t) => Number.isFinite(t));
                if (validReturns.length > 0) {
                    const Tf_actual = validReturns.reduce((sum, t) => sum + t, 0) / validReturns.length;
                    const deltaT = Tsupply - Tf_actual;

                    // Estimate based on ΔT and flow assumption
                    // Q ≈ n_loops × 0.1 kg/s × 4.18 kJ/(kg·K) × ΔT (kW)
                    const n_loops = validReturns.length;
                    room_load_est = n_loops * 0.1 * 4.18 * deltaT;

                    // Clamp to reasonable range based on floor area if available
                    if (room_load_est < 0) room_load_est = 0;
                    if (floorArea > 0) {
                        // Max ~120 W/m² for floor heating
                        const maxLoad = floorArea * 0.12; // kW
                        if (room_load_est > maxLoad) room_load_est = maxLoad;
                    } else {
                        // Fallback clamp if no floor area configured
                        if (room_load_est > 10) room_load_est = 10;
                    }

                    node.debug(`[mpc-room:${node.name}] Load estimate: ${room_load_est.toFixed(2)}kW (${n_loops} loops, ΔT=${deltaT.toFixed(1)}°C, area=${floorArea}m²)`);
                }
            }

            // --- Publish outputs ---
            if (tfSetOutTopic) {
                node.send({ topic: tfSetOutTopic, payload: parseFloat(Tf_set.toFixed(2)) });
            }

            // Publish load estimate only if output topic configured
            if (roomLoadEstOutTopic && room_load_est !== null) {
                node.send({ topic: roomLoadEstOutTopic, payload: parseFloat(room_load_est.toFixed(3)) });
            }

            // Update status (show load estimate if available, regardless of output topic)
            const biasStr = Math.abs(Tf_bias) > 0.01 ? ` bias=${Tf_bias.toFixed(2)}` : "";
            const loadStr = room_load_est !== null ? ` Q=${room_load_est.toFixed(1)}kW` : "";
            setStatus(`Ti ${Ti.toFixed(1)}°C, Tf_set ${Tf_set.toFixed(1)}°C${biasStr}${loadStr}`, "green");

            node.debug(`[mpc-room:${node.name}] Ti=${Ti.toFixed(1)} Tset=${Tset.toFixed(1)} e=${e_room.toFixed(2)} → Tf_set=${Tf_set.toFixed(1)} bias=${Tf_bias.toFixed(3)}`);
        }

        // ---- Publish room tick
        function publishRoomTick(payload) {
            const tsNowSec = Math.floor(Date.now() / 1000);
            const tickPayload = { ts: tsNowSec, periodSec: Number(payload?.periodSec || lastPeriodSec || 300) };

            node.send({ topic: node.roomTickTopic, payload: tickPayload });
            setStatus(`Tick published (${ts.formatStatus()})`, "blue");
        }

        // ---- Input handler
        node.on("input", (msg) => {
            const t = msg.topic || "";

            // Global tick - triggers computation and publishes room tick
            if (t === node.globalTickTopic) {
                const ts = msg.payload?.ts;
                const periodSec = Number(msg.payload?.periodSec);

                if (!ts || !periodSec) {
                    setStatus(`Invalid tick (${ts.formatStatus()})`, "red");
                    return;
                }

                if (lastGlobalTickTs !== ts) {
                    lastGlobalTickTs = ts;
                    lastPeriodSec = periodSec;

                    setStatus(`Tick delayed until ${new Date().toLocaleTimeString()} (+${node.tickDelaySec}s)`, "blue");

                    setTimeout(
                        () => {
                            computeAndPublish();
                            publishRoomTick(msg.payload);
                        },
                        Math.max(0, node.tickDelaySec * 1000)
                    );
                }
                return;
            }

            // Update state from other topics
            if (t === tRoomTopic && msg.payload != null) {
                Ti = parseFloat(msg.payload);
                return;
            }

            if (t === spRoomTopic && msg.payload != null) {
                Tset = parseFloat(msg.payload);
                return;
            }

            if (t === tOutTopic && msg.payload != null) {
                Tout = parseFloat(msg.payload);
                return;
            }

            if (t === tsupplyTopic && msg.payload != null) {
                Tsupply = parseFloat(msg.payload);
                return;
            }

            if (tReturnTopics.includes(t) && msg.payload != null) {
                tReturnState[t] = parseFloat(msg.payload);
                return;
            }
        });
    }

    RED.nodes.registerType("uniflex-mpc-room", MpcRoomNode);
};
