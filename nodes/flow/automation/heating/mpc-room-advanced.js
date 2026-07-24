const ts = require("../../core/lib/timestamp.js");
// mpc-room-advanced.js
// Extended MPC Room Layer: tick-driven floor setpoint with solar gain FF and envelope loss compensation
// Based on mpc-room.js v2.0.0-redesigned

const http = require("http");
const fs = require("fs");
const path = require("path");

module.exports = function (RED) {
    const NODE_VERSION = "4.4.0-solar-floor-lag";

    function MpcRoomAdvancedNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Startup grace period: skip forecast checks for first 10s to allow forecast-cache to populate
        const nodeStartupTime = Date.now();
        const STARTUP_GRACE_MS = 10000;

        // ---- CONFIG: base (from mpc-room)
        node.name = config.name || "";
        node.globalTickTopic = config.globalTickTopic || "";
        node.tickDelaySec = Number(config.tickDelaySec ?? 0);
        node.roomTickTopic = config.roomTickTopic || `heating/${node.name || "unknown"}/tick`;

        const Tref = parseFloat(config.Tref) || 0;
        const a = parseFloat(config.hcOffset) || 26;
        const b = parseFloat(config.hcSlope) || 0.2;
        const k_e = parseFloat(config.k_e) || 0.5;
        const Tf_min = parseFloat(config.Tf_min) || 23;
        const Tf_max = parseFloat(config.Tf_max) || 29;

        const bandL = parseFloat(config.band_low) || 0.2;
        const bandH = parseFloat(config.band_high) || 0.4;

        const enableAdaptiveBias = config.enableAdaptiveBias !== false;
        const biasLearningRate = parseFloat(config.biasLearningRate) || 0.0001;
        const biasClamp = parseFloat(config.biasClamp) || 1.0;

        const floorArea = parseFloat(config.floorArea) || 0;
        // Effective thermal mass per m²: air only ≈ 0.0009, furnished room ≈ 0.03–0.10 kWh/K/m²
        const roomMassGain = parseFloat(config.roomMassGain) || 0.05;

        const tRoomTopic = (config.tRoomTopic || "").trim();
        const spRoomTopic = (config.spRoomTopic || "").trim();
        const tOutTopic = (config.tOutTopic || "").trim();
        const tsupplyTopic = (config.tsupplyTopic || "").trim();

        const rawTReturnList = Array.isArray(config.tReturnTopics) ? config.tReturnTopics : typeof config.tReturnTopics === "string" ? config.tReturnTopics.split(",") : [];
        const tReturnTopics = rawTReturnList.map((s) => (s || "").trim()).filter((s) => s.length > 0);

        const tfSetOutTopic = (config.tfSetOutTopic || "").trim();
        const roomLoadEstOutTopic = (config.roomLoadEstOutTopic || "").trim();

        // ---- CONFIG: solar & envelope
        const windowArea = parseFloat(config.windowArea) || 0;
        const windowAzimuth = parseFloat(config.windowAzimuth) || 180;
        const windowArea2 = parseFloat(config.windowArea2) || 0;
        const windowAzimuth2 = parseFloat(config.windowAzimuth2) || 0;
        const solarCoeff = parseFloat(config.solarCoeff) || 0.5;
        const opaqueArea = parseFloat(config.opaqueArea) || 0;

        const latitude = parseFloat(config.latitude) || 58.9;
        const longitude = parseFloat(config.longitude) || 25.6;
        const uWindow = parseFloat(config.uWindow) || 1.0;
        const uWall = parseFloat(config.uWall) || 0.15;
        // ---- CONFIG: FF parameters
        const ffLeadHours = parseFloat(config.ffLeadHours) || 6.0;
        const ffMaxAdj = parseFloat(config.ffMaxAdj) || 3.0;
        const ffMaxTotal = parseFloat(config.ffMaxTotal) || 3.0;

        // ---- CONFIG: adaptive FF
        const useAdaptiveFF = config.useAdaptiveFF || false;
        const ffTimeLagsTopic = (config.ffTimeLagsTopic || "").trim();
        const ffGainsTopic = (config.ffGainsTopic || "").trim();

        // ---- CONFIG: learning window (hours 0-23, local time)
        // FF params are only accepted from the iolayer within this window.
        // Outside the window, incoming FT/FG values are ignored so a stale/reset
        // iolayer cannot overwrite the last good persisted params.
        // Set both to -1 to disable the guard (accept at any time).
        // Priority: thermalModel node > legacy heatingConfig > per-node settings > defaults.
        let _bcfg = config.thermalModel ? RED.nodes.getNode(config.thermalModel) : null;
        if (!_bcfg && config.heatingConfig) {
            _bcfg = RED.nodes.getNode(config.heatingConfig);
            if (_bcfg) {
                node.warn(`[mpc-room-adv:${node.name}] heatingConfig is deprecated; link thermalModel instead`);
            }
        }
        const learningWindowStart = parseInt(_bcfg ? (_bcfg.learningWindowStart ?? 2) : (config.learningWindowStart ?? 2));
        const learningWindowEnd = parseInt(_bcfg ? (_bcfg.learningWindowEnd ?? 4) : (config.learningWindowEnd ?? 4));

        // Balance temperature: outdoor temp at which no net heating needed (internal gains cover losses).
        // Net demand = Uroom * max(0, Tbalance + chargeK - Tout) -- replaces Tset in gross loss formula.
        const Tbalance = Number(_bcfg ? (_bcfg.Tbalance ?? 15.0) : (config.Tbalance ?? 15.0));

        function isLearningWindowOpen() {
            if (learningWindowStart < 0 || learningWindowEnd < 0) return true; // disabled
            const h = new Date().getHours();
            if (learningWindowStart <= learningWindowEnd) {
                return h >= learningWindowStart && h < learningWindowEnd;
            }
            return h >= learningWindowStart || h < learningWindowEnd; // wrap-around
        }

        // ---- CONFIG: persistence
        {
            const _pfx = "mpc-room-advanced";
            const _safe = (node.name || node.id).replace(/\s+/g, "-");
            const _stem = _safe === _pfx || _safe.startsWith(_pfx + "-") ? _safe : `${_pfx}-${_safe}`;
            const _dir = (config.persistencePath || "").trim();
            node.persistenceFile = _dir ? path.join(_dir, `${_stem}.json`) : null;
        }

        const ffComponentsOutTopic = (config.ffComponentsOutTopic || "").trim();
        const ffTotalAdjOutTopic = (config.ffTotalAdjOutTopic || "").trim(); // TExW.5 - total FF adjustment in dC

        // ---- CONFIG: demand forecast & health
        const healthOutTopic = (config.healthOutTopic || "").trim();
        const forecastCacheMaxAgeMs = 14 * 3600 * 1000; // 14h to cover twice-daily updates (4:40, 16:40)

        // ---- STATE
        let Ti = null;
        let Tset = null;
        let Tout = null;
        let Tsupply = null;
        const tReturnState = {};

        let windSpeed = null;
        let irradianceNow = null;

        // Adaptive FF state (read from datastreams)
        let tau_solar = null; // hours (from datastream with coeff=3600)
        let tau_thermal = null; // hours (from datastream with coeff=3600)
        let gain_solar = null; // dimensionless
        let gain_temp = null;
        let gain_wind = null;

        let Tf_bias = 0;
        let lastGlobalTickTs = null;
        let lastPeriodSec = null;
        let lastEmergencyTs = null; // Cooldown for emergency triggers

        // Room name used as key in roomForecasts -- derived once at node level
        const nodeRoomName = node.name || node.id;
        // Last computed demand forecast -- persisted so mpc-house can use it immediately after restart
        let lastForecastEntry = null;

        let lastSolarGain = null;
        let lastFfAdj = null;

        const DEG2RAD = Math.PI / 180;
        const RAD2DEG = 180 / Math.PI;
        const latRad = latitude * DEG2RAD;

        // ======================================================================
        // SOLAR POSITION (for facade geometry only -- irradiance comes from sun-handler)
        // ======================================================================

        function dayOfYear(date) {
            const start = new Date(date.getFullYear(), 0, 0);
            return Math.floor((date - start) / 86400000);
        }

        function solarPosition(date) {
            const doy = dayOfYear(date);
            const declRad = 23.45 * DEG2RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);

            const solarTimeHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600 + longitude / 15;
            const hourAngleRad = (solarTimeHours - 12) * 15 * DEG2RAD;

            const sinAlt = Math.sin(latRad) * Math.sin(declRad) + Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngleRad);
            const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

            let azimuth = 0;
            const cosAlt = Math.cos(altitude);
            if (cosAlt > 1e-6) {
                let cosAz = (Math.sin(declRad) - sinAlt * Math.sin(latRad)) / (cosAlt * Math.cos(latRad));
                cosAz = Math.max(-1, Math.min(1, cosAz));
                azimuth = Math.acos(cosAz);
                if (hourAngleRad > 0) azimuth = 2 * Math.PI - azimuth;
            }

            return {
                altitudeDeg: altitude * RAD2DEG,
                altitudeRad: altitude,
                azimuthDeg: azimuth * RAD2DEG,
                azimuthRad: azimuth
            };
        }

        // ======================================================================
        // SOLAR GAIN (from GHI irradiance + facade geometry)
        // ======================================================================

        function computeRoomSolarGain(date, irradianceKwM2, area, azimuth) {
            if (area <= 0 || !Number.isFinite(irradianceKwM2) || irradianceKwM2 <= 0) return 0;
            const sun = solarPosition(date);
            if (sun.altitudeDeg <= 0) return 0;
            const sinAlt = Math.sin(sun.altitudeRad);
            if (sinAlt < 0.01) return 0;
            const facadeAzRad = azimuth * DEG2RAD;
            const cosAzDiff = Math.cos(sun.azimuthRad - facadeAzRad);
            if (cosAzDiff <= 0) return 0;
            const facadeIrr = irradianceKwM2 * (Math.cos(sun.altitudeRad) / sinAlt) * cosAzDiff;
            return area * solarCoeff * facadeIrr;
        }

        // ======================================================================
        // FORECAST FROM CONTEXT
        // ======================================================================

        function getForecastIrradiance(leadSec) {
            const cache = node.context().global.get("forecastCache");

            // No fallback - if no cache, system is broken
            if (!cache) {
                node.error("[mpc-room-adv] forecastCache is null/undefined - cannot compute FF");
                return null;
            }
            if (!cache.irradiance) {
                node.error(`[mpc-room-adv] forecastCache.irradiance missing (cache keys: ${Object.keys(cache).join(",")}) - cannot compute FF`);
                return null;
            }

            if (Date.now() - cache.timestamp > forecastCacheMaxAgeMs) {
                node.error(`[mpc-room-adv] forecastCache stale (age: ${Math.floor((Date.now() - cache.timestamp) / 1000)}s) - cannot compute FF`);
                return null;
            }

            // Find forecast value at lead time
            const targetTs = Math.floor(Date.now() / 1000) + leadSec;
            const slot = Math.floor((targetTs - cache.baseSlot) / cache.stepSec);

            if (slot < 0 || slot >= cache.irradiance.length) {
                node.error(`[mpc-room-adv] Forecast slot ${slot} out of range [0, ${cache.irradiance.length})`);
                return null;
            }

            return Math.max(0, cache.irradiance[slot]);
        }

        // ======================================================================
        // FEEDFORWARD COMPUTATION
        // ======================================================================

        function computeWindFF() {
            if (windSpeed == null || !Number.isFinite(windSpeed)) return 0;
            if (!Number.isFinite(Ti) || !Number.isFinite(Tout)) return 0;
            if (windSpeed <= 0) return 0;

            const dT = Math.max(0, Ti - Tout); // Only heating mode
            const params = getFFParams();
            return params.gain_wind * windSpeed * dT;
        }

        // ======================================================================
        // PERSISTENCE (FF params + adaptive bias)
        // ======================================================================

        function loadState() {
            if (!node.persistenceFile) return;
            try {
                const data = JSON.parse(fs.readFileSync(node.persistenceFile, "utf8"));
                if (Number.isFinite(data.tau_solar)) tau_solar = data.tau_solar;
                if (Number.isFinite(data.tau_thermal)) tau_thermal = data.tau_thermal;
                if (Number.isFinite(data.gain_solar)) gain_solar = data.gain_solar;
                if (Number.isFinite(data.gain_temp)) gain_temp = data.gain_temp;
                if (Number.isFinite(data.gain_wind)) gain_wind = data.gain_wind;
                if (Number.isFinite(data.Tf_bias)) Tf_bias = data.Tf_bias;
                if (data.lastForecastEntry && Array.isArray(data.lastForecastEntry.Q_demand) && data.lastForecastEntry.Q_demand.length > 0) {
                    lastForecastEntry = data.lastForecastEntry;
                    const ageMins = ((Date.now() - (lastForecastEntry.timestamp || 0)) / 60000).toFixed(0);
                    // Restore into global context immediately so mpc-house can use it without waiting for a tick
                    const forecasts = node.context().global.get("roomForecasts") || {};
                    forecasts[nodeRoomName] = lastForecastEntry;
                    node.context().global.set("roomForecasts", forecasts);
                    node.log(`[mpc-room-adv:${nodeRoomName}] Forecast restored from persistence (${lastForecastEntry.Q_demand.length} slots, age=${ageMins}min)`);
                }
                node.log(
                    `[mpc-room-adv:${node.name}] State loaded: tau_sol=${tau_solar != null ? tau_solar.toFixed(1) : "null"}h tau_th=${tau_thermal != null ? tau_thermal.toFixed(1) : "null"}h gain_sol=${gain_solar} gain_T=${gain_temp} gain_W=${gain_wind} bias=${Tf_bias.toFixed(3)}`
                );
            } catch (e) {
                node.debug(`[mpc-room-adv:${node.name}] No previous state (${e.message})`);
            }
        }

        function saveState() {
            if (!node.persistenceFile) return;
            try {
                fs.writeFileSync(
                    node.persistenceFile,
                    JSON.stringify(
                        {
                            tau_solar,
                            tau_thermal,
                            gain_solar,
                            gain_temp,
                            gain_wind,
                            Tf_bias,
                            lastForecastEntry
                        },
                        null,
                        2
                    ),
                    "utf8"
                );
            } catch (e) {
                node.error(`[mpc-room-adv:${node.name}] Failed to save state: ${e.message}`);
            }
        }

        loadState();

        // ======================================================================
        // STATUS & LOGGING
        // ======================================================================

        function setStatus(text, fill) {
            node.status({ fill: fill || "blue", shape: "dot", text });
        }

        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }

        node.log(
            `[mpc-room-adv:${node.name}] *** VERSION ${NODE_VERSION} *** | ` +
                `tick: ${node.globalTickTopic} -> ${node.roomTickTopic} (delay ${node.tickDelaySec}s) | ` +
                `curve: a=${a} b=${b} k_e=${k_e} | adaptive: ${enableAdaptiveBias ? "on" : "off"} | ` +
                `window: ${windowArea}m2 az=${windowAzimuth}deg${windowArea2 > 0 ? ` + ${windowArea2}m2 az=${windowAzimuth2}deg` : ""} coeff=${solarCoeff} | ` +
                `opaque: ${opaqueArea}m2 | Uw=${uWindow} Uwall=${uWall} | ` +
                `ff: ${useAdaptiveFF ? `ADAPTIVE (${ffTimeLagsTopic}, ${ffGainsTopic})` : `datastream (${ffGainsTopic})`} fallback_lead=${ffLeadHours}h maxAdj=${ffMaxAdj}degC maxTotal=${ffMaxTotal}degC | ` +
                `startup_grace=${STARTUP_GRACE_MS / 1000}s`
        );

        setStatus(`Ready - waiting for tick: ${node.globalTickTopic || "n/a"}`, "grey");

        // ======================================================================
        // ADAPTIVE FF PARAMETERS
        // ======================================================================

        function getFFParams() {
            // Always use values from datastreams (FFTxW, FFGxW)
            // If not available, use fallback time lag and gains default to 0
            // tau values come from datastream already converted to hours (coeff=3600)
            return {
                tau_solar: tau_solar || ffLeadHours,
                tau_thermal: tau_thermal || ffLeadHours,
                gain_solar: gain_solar || 0,
                gain_temp: gain_temp || 0,
                gain_wind: gain_wind || 0
            };
        }

        // ======================================================================
        // CHARGE FF (price-based, from mpc-house via global context)
        // ======================================================================

        function computeChargeFF() {
            const sig = node.context().global.get("chargeSignal");
            if (!sig || !sig.adj || !sig.baseSlot || !sig.stepSec) return 0;
            if (Date.now() - sig.timestamp > forecastCacheMaxAgeMs) return 0;
            const nowSec = Math.floor(Date.now() / 1000);
            const slot = Math.floor((nowSec - sig.baseSlot) / sig.stepSec);
            if (slot < 0 || slot >= sig.adj.length) return 0;
            const v = sig.adj[slot];
            return Number.isFinite(v) ? v : 0;
        }

        // ======================================================================
        // COMPUTE & PUBLISH
        // ======================================================================

        function computeAndPublish(forecastIrradiance) {
            try {
                if (Ti == null || Tset == null) {
                    setStatus(`Waiting inputs (${ts.formatStatus()})`, "grey");
                    node.warn(`[mpc-room-adv] Cannot compute: Ti=${Ti} Tset=${Tset}`);
                    return;
                }

                // Forecast is preferred but not required - fallback to 0 for FF components
                const hasForecast = forecastIrradiance !== null;
                if (!hasForecast) {
                    // During startup grace period, this is expected - don't complain
                    const timeSinceStartup = Date.now() - nodeStartupTime;
                    if (timeSinceStartup >= STARTUP_GRACE_MS) {
                        node.warn("[mpc-room-adv] Forecast unavailable - using zero FF adjustment");
                    }
                }

                const ToutUsed = Number.isFinite(Tout) ? Tout : Tref;

                node.log(`[mpc-room-adv] Computing: Ti=${Ti} Tset=${Tset} Tout=${ToutUsed} hasForecast=${hasForecast}`);

                // Get FF parameters (adaptive or manual)
                const params = getFFParams();

                // Compute FF components in kW (power) using adaptive time lags (in hours)
                // Solar FF uses two look-ahead horizons: floor circuits need an extra lead for
                // pipe-to-surface thermal lag (floor_lead_hours from thermal model config).
                const floor_lead_h = _hcfg ? _hcfg.floor_lead_hours || 2.0 : 2.0;
                const futureDate_solar_floor = new Date(Date.now() + (params.tau_solar + floor_lead_h) * 3600 * 1000);
                const futureDate_solar_air = new Date(Date.now() + params.tau_solar * 3600 * 1000);
                const futureDate_thermal = new Date(Date.now() + params.tau_thermal * 3600 * 1000);

                // Solar gain at two horizons (positive = heat gain entering room)
                let Q_solar_floor = 0,
                    Q_solar_air = 0;
                if (hasForecast && windowArea > 0) {
                    Q_solar_floor += computeRoomSolarGain(futureDate_solar_floor, forecastIrradiance, windowArea, windowAzimuth);
                    Q_solar_air += computeRoomSolarGain(futureDate_solar_air, forecastIrradiance, windowArea, windowAzimuth);
                }
                if (hasForecast && windowArea2 > 0) {
                    Q_solar_floor += computeRoomSolarGain(futureDate_solar_floor, forecastIrradiance, windowArea2, windowAzimuth2);
                    Q_solar_air += computeRoomSolarGain(futureDate_solar_air, forecastIrradiance, windowArea2, windowAzimuth2);
                }
                Q_solar_floor = -Q_solar_floor; // Negative = heat gain (reduce heating need)
                Q_solar_air = -Q_solar_air;

                const dT_env = Number.isFinite(Tout) && Number.isFinite(Ti) ? Ti - Tout : 0;
                const totalWindowArea = windowArea + windowArea2;
                const Q_loss_room = ((totalWindowArea * uWindow + opaqueArea * uWall) * dT_env) / 1000;
                const Q_envelope = Q_loss_room;

                // Auto floor/air split ratio: floor_frac = Q_floor_nom / (Q_floor_nom + Q_design)
                // Q_design = room heat loss at nominal 20K dT (same geometry, design conditions)
                // Q_floor_nom = floorArea * 50 W/m2 (nominal underfloor circuit power density)
                const Q_design_room = ((totalWindowArea * uWindow + opaqueArea * uWall) * 20) / 1000; // kW at 20K
                const Q_floor_nom = floorArea * 0.05; // 50 W/m2 -> kW
                const floor_frac = floorArea > 0 && Q_floor_nom > 0 ? Math.min(Q_floor_nom / (Q_floor_nom + Math.max(Q_design_room, 0.1)), 0.9) : 0.75; // fallback when no floor area configured

                const Q_wind = computeWindFF();

                // Price charge FF: convert from temperature adjustment (chargeSignal) to power for monitoring
                const Tf_charge_ff = computeChargeFF(); // Returns +/-chargeMaxDeg from mpc-house
                // Convert Tf adjustment to approximate power for monitoring (using typical floor heat transfer)
                // For monitoring purposes: assume K_room ~ 0.3 kW/K and typical dT_supply ~ 5K
                const Q_charge = (Tf_charge_ff * 0.3) / 5.0; // Rough estimate in kW

                // Convert environmental FF to temperature adjustments using adaptive gains
                const e_room = Tset - Ti; // Room error WITHOUT charge (charge goes directly to floor)

                const Tf_base = a + b * (Tref - ToutUsed);
                const Tf_trim = k_e * e_room;

                // Solar FF split: floor fraction uses pre-shifted look-ahead, air uses normal tau_solar
                const Tf_solar_ff_floor = clamp(-params.gain_solar * Q_solar_floor * floor_frac, -ffMaxAdj, ffMaxAdj);
                const Tf_solar_ff_air = clamp(-params.gain_solar * Q_solar_air * (1 - floor_frac), -ffMaxAdj, ffMaxAdj);
                const Tf_solar_ff = clamp(Tf_solar_ff_floor + Tf_solar_ff_air, -ffMaxAdj, ffMaxAdj);
                const Tf_temp_ff = clamp(params.gain_temp * Q_envelope, -ffMaxAdj, ffMaxAdj);
                const Tf_wind_ff = clamp(params.gain_wind * Q_wind, -ffMaxAdj, ffMaxAdj);
                const Tf_ff_total = clamp(Tf_solar_ff + Tf_temp_ff + Tf_wind_ff, -ffMaxTotal, ffMaxTotal);

                // Add charge FF directly to floor setpoint (not via room error)
                let Tf_set = Tf_base + Tf_trim + Tf_bias + Tf_ff_total + Tf_charge_ff;
                Tf_set = clamp(Tf_set, Tf_min, Tf_max);

                const irrNowUsed = Number.isFinite(irradianceNow) ? irradianceNow : Number.isFinite(forecastIrradiance) ? forecastIrradiance : 0;

                let qSolarNow = 0;
                const nowDate = new Date();
                if (windowArea > 0) {
                    qSolarNow += computeRoomSolarGain(nowDate, irrNowUsed, windowArea, windowAzimuth);
                }
                if (windowArea2 > 0) {
                    qSolarNow += computeRoomSolarGain(nowDate, irrNowUsed, windowArea2, windowAzimuth2);
                }

                // Adaptive bias learning
                if (enableAdaptiveBias && tReturnTopics.length > 0) {
                    const validReturns = Object.values(tReturnState).filter((t) => Number.isFinite(t));
                    if (validReturns.length > 0) {
                        const Tf_actual = validReturns.reduce((sum, t) => sum + t, 0) / validReturns.length;
                        const atLimit = Tf_set <= Tf_min || Tf_set >= Tf_max;
                        if (Math.abs(e_room) > 0.1 && Math.abs(e_room) < 2.0 && !atLimit) {
                            const bias_before = Tf_bias;
                            Tf_bias += biasLearningRate * e_room;
                            Tf_bias = clamp(Tf_bias, -biasClamp, biasClamp);
                            const bias_change = Tf_bias - bias_before;
                            if (Math.abs(Tf_bias) % 0.05 < Math.abs(bias_before) % 0.05 || Math.abs(Tf_bias) > 0.8) {
                                node.log(
                                    `[mpc-room-adv:${node.name}] bias learn: e=${e_room.toFixed(2)} -> bias=${Tf_bias.toFixed(3)} (delta${bias_change >= 0 ? "+" : ""}${bias_change.toFixed(4)})`
                                );
                            }
                        }
                        const Tf_error = Tf_actual - Tf_set;
                        if (Math.abs(Tf_error) > 3.0) {
                            node.warn(`[mpc-room-adv:${node.name}] Large floor error: Tf_act=${Tf_actual.toFixed(1)} vs Tf_set=${Tf_set.toFixed(1)} (err=${Tf_error.toFixed(1)})`);
                        }
                    }
                }

                // Room load estimate
                let room_load_est = null;
                if (Number.isFinite(Tsupply) && tReturnTopics.length > 0) {
                    const validReturns = Object.values(tReturnState).filter((t) => Number.isFinite(t));
                    if (validReturns.length > 0) {
                        const Tf_actual = validReturns.reduce((sum, t) => sum + t, 0) / validReturns.length;
                        const deltaT = Tsupply - Tf_actual;
                        const n_loops = validReturns.length;
                        room_load_est = n_loops * 0.1 * 4.18 * deltaT;
                        if (room_load_est < 0) room_load_est = 0;
                        if (floorArea > 0) {
                            room_load_est = Math.min(room_load_est, floorArea * 0.12);
                        } else {
                            room_load_est = Math.min(room_load_est, 10);
                        }
                    }
                }

                const messages = [];
                if (tfSetOutTopic) {
                    messages.push({ topic: tfSetOutTopic, payload: parseFloat(Tf_set.toFixed(2)) });
                }
                if (roomLoadEstOutTopic && room_load_est !== null) {
                    messages.push({ topic: roomLoadEstOutTopic, payload: parseFloat(room_load_est.toFixed(3)) });
                }
                // FF components datastream (4 members in kW, write node converts to W with coeff 1000)
                if (ffComponentsOutTopic) {
                    messages.push({ topic: ffComponentsOutTopic + ".1", payload: parseFloat(Q_solar_air.toFixed(4)) }); // Solar (kW)
                    messages.push({ topic: ffComponentsOutTopic + ".2", payload: parseFloat(Q_envelope.toFixed(4)) }); // Envelope (kW)
                    messages.push({ topic: ffComponentsOutTopic + ".3", payload: parseFloat(Q_wind.toFixed(4)) }); // Wind (kW)
                    messages.push({ topic: ffComponentsOutTopic + ".4", payload: parseFloat(Q_charge.toFixed(4)) }); // Charge (kW)
                }

                // Total FF adjustment in C for monitoring (write node coeff=10 converts to dC for iolayer)
                if (ffTotalAdjOutTopic) {
                    const totalFFAdj = Tf_ff_total + Tf_charge_ff; // Combined environmental + price charge
                    messages.push({ topic: ffTotalAdjOutTopic, payload: parseFloat(totalFFAdj.toFixed(2)) });
                }

                node.log(`[mpc-room-adv] Sending ${messages.length} messages: ${messages.map((m) => `${m.topic}=${m.payload}`).join(", ")}`);
                if (messages.length > 0) {
                    node.send([messages]); // Single output, multiple messages
                }

                lastSolarGain = qSolarNow;
                lastFfAdj = Tf_ff_total;

                const biasStr = Math.abs(Tf_bias) > 0.01 ? ` b=${Tf_bias.toFixed(2)}` : "";
                const loadStr = room_load_est !== null ? ` Q=${room_load_est.toFixed(1)}kW` : "";
                const solarStr = qSolarNow > 0.01 ? ` sol=${qSolarNow.toFixed(2)}kW` : "";
                const ffStr = Math.abs(Tf_ff_total) > 0.01 ? ` ff=${Tf_ff_total.toFixed(1)}` : "";
                const chargeStr = Math.abs(Tf_charge_ff) > 0.01 ? ` chg=${Tf_charge_ff.toFixed(2)}` : "";
                const forecastWarning = !hasForecast ? " [no forecast]" : "";
                setStatus(`Ti ${Ti.toFixed(1)} Tf ${Tf_set.toFixed(1)}${biasStr}${solarStr}${ffStr}${chargeStr}${loadStr}${forecastWarning}`, hasForecast ? "green" : "yellow");

                const chargeStr_log = Math.abs(Tf_charge_ff) > 0.01 ? ` chg=${Tf_charge_ff.toFixed(2)}` : "";
                const tauInfo = useAdaptiveFF ? ` tau_sol=${params.tau_solar.toFixed(1)}h tau_th=${params.tau_thermal.toFixed(1)}h` : "";
                node.log(
                    `[mpc-room-adv:${node.name}] Ti=${Ti.toFixed(1)} Tset=${Tset.toFixed(1)}${chargeStr_log} Tout=${ToutUsed.toFixed(1)} ` +
                        `e=${e_room.toFixed(2)} base=${Tf_base.toFixed(1)} trim=${Tf_trim.toFixed(2)} bias=${Tf_bias.toFixed(3)}${tauInfo} ` +
                        `solFF=${Tf_solar_ff.toFixed(2)} tempFF=${Tf_temp_ff.toFixed(2)} windFF=${Tf_wind_ff.toFixed(2)} chgFF=${Tf_charge_ff.toFixed(2)} ffTot=${Tf_ff_total.toFixed(2)} -> Tf=${Tf_set.toFixed(1)} ` +
                        `Qsol=${qSolarNow.toFixed(2)}kW irr=${irrNowUsed.toFixed(3)}kW/m2`
                );
            } catch (error) {
                node.error(`[mpc-room-adv] EXCEPTION in computeAndPublish: ${error.message}`);
                node.error(error.stack);
            }
        }

        // ======================================================================
        // DEMAND FORECAST (for mpc-house aggregation via flow context)
        // ======================================================================

        function computeAndStoreRoomDemandForecast() {
            const cache = node.context().global.get("forecastCache");
            const roomName = node.name || node.id;
            let healthy = true;

            if (!cache || !cache.Tout || !cache.irradiance || Date.now() - cache.timestamp > forecastCacheMaxAgeMs) {
                healthy = false;
                node.warn(`[mpc-room-adv:${roomName}] forecastCache missing or stale -- skipping demand forecast`);
                publishHealth(healthy);
                return;
            }

            if (!Number.isFinite(Tset) || Tset < 5) {
                healthy = false;
                node.warn(`[mpc-room-adv:${roomName}] Tset invalid (${Tset}) -- skipping demand forecast`);
                publishHealth(healthy);
                return;
            }

            const S = cache.slots;
            const stepSec = cache.stepSec;
            const baseSlot = cache.baseSlot;
            const totalWindowArea = windowArea + windowArea2;
            const Uroom = (totalWindowArea * uWindow + opaqueArea * uWall) / 1000; // kW/K

            // Effective room thermal mass: air + furniture + exposed wall/floor surface
            // Pure air: 0.0009 kWh/K/m². Furnished room: 0.03–0.10 kWh/K/m². Default 0.05.
            const C_room = (floorArea || 50) * roomMassGain;

            const Q_demand_room = new Array(S);

            const chargeSig = node.context().global.get("chargeSignal");
            const chargeValid = chargeSig && chargeSig.adj && chargeSig.stepSec && Date.now() - chargeSig.timestamp < forecastCacheMaxAgeMs;

            for (let k = 0; k < S; k++) {
                const slotTs = baseSlot + k * stepSec;
                const slotDate = new Date(slotTs * 1000);
                const Tout_k = cache.Tout[k];
                const irr_k = cache.irradiance[k];

                let chargeK = 0;
                if (chargeValid) {
                    const cSlot = Math.floor((slotTs - chargeSig.baseSlot) / chargeSig.stepSec);
                    if (cSlot >= 0 && cSlot < chargeSig.adj.length) chargeK = chargeSig.adj[cSlot];
                }

                // Use Tbalance (instead of Tset) to account for internal gains:
                // demand is zero when Tout >= Tbalance, matching the building's real balance point.
                const Qloss = Uroom * Math.max(0, Tbalance + chargeK - Tout_k);

                let Qsolar = 0;
                if (windowArea > 0) {
                    Qsolar += computeRoomSolarGain(slotDate, irr_k, windowArea, windowAzimuth);
                }
                if (windowArea2 > 0) {
                    Qsolar += computeRoomSolarGain(slotDate, irr_k, windowArea2, windowAzimuth2);
                }

                Q_demand_room[k] = Math.max(0, Qloss - Qsolar);
            }

            // Simulate room temperature without heating for comfort check
            let Ti_sim = Ti;
            const Ti_forecast_noHeat = [];
            for (let k = 0; k < S; k++) {
                const slotTs = baseSlot + k * stepSec;
                const slotDate = new Date(slotTs * 1000);
                const Tout_k = cache.Tout[k];
                const irr_k = cache.irradiance[k];

                // Compute solar gain for this slot
                let Qsolar = 0;
                if (windowArea > 0) {
                    Qsolar += computeRoomSolarGain(slotDate, irr_k, windowArea, windowAzimuth);
                }
                if (windowArea2 > 0) {
                    Qsolar += computeRoomSolarGain(slotDate, irr_k, windowArea2, windowAzimuth2);
                }

                const Qloss = Uroom * (Ti_sim - Tout_k);
                const dTi = ((Qsolar - Qloss) / C_room) * (stepSec / 3600); // kW / (kWh/K) * h = K
                Ti_sim += dTi;
                Ti_forecast_noHeat.push(Ti_sim);
            }

            const forecasts = node.context().global.get("roomForecasts") || {};
            forecasts[roomName] = {
                timestamp: Date.now(),
                stepSec,
                baseSlot,
                slots: S,
                Q_demand: Q_demand_room,
                floorArea: floorArea || 0,
                healthy: true,
                // Per-room comfort data
                Tset: Tset,
                Ti_now: Ti,
                Ti_forecast_noHeat: Ti_forecast_noHeat, // Predicted Ti without heating
                Tmin: Tset - 0.3 // Per-room minimum (tight tolerance)
            };
            node.context().global.set("roomForecasts", forecasts);
            lastForecastEntry = forecasts[roomName];
            saveState();

            const sumDemand = Q_demand_room.reduce((a, b) => a + b, 0);
            const avgDemand = sumDemand / S;
            const maxDemand = Math.max(...Q_demand_room);
            node.log(`[mpc-room-adv:${roomName}] Demand forecast: ${S} slots, avg=${avgDemand.toFixed(2)}kW max=${maxDemand.toFixed(2)}kW Uroom=${Uroom.toFixed(3)}kW/K`);

            publishHealth(healthy);
        }

        function publishHealth(healthy) {
            if (healthOutTopic) {
                node.send({ topic: healthOutTopic, payload: healthy ? 1 : 0 });
            }
        }

        // ======================================================================
        // TICK HANDLER
        // ======================================================================

        function onTick(tickPayload) {
            // Check if forecast is available first
            const cache = node.context().global.get("forecastCache");
            if (!cache || !cache.irradiance) {
                // During startup grace period, this is expected - don't complain
                const timeSinceStartup = Date.now() - nodeStartupTime;
                if (timeSinceStartup < STARTUP_GRACE_MS) {
                    node.debug(`[mpc-room-adv] Startup grace (${(timeSinceStartup / 1000).toFixed(0)}s) - forecast not yet available`);
                } else {
                    node.log("[mpc-room-adv] Forecast not yet available - skipping FF until next tick");
                }
                computeAndPublish(null); // Will use zero FF
                computeAndStoreRoomDemandForecast();
                return;
            }

            // Get forecast irradiance from flow context using adaptive lead time
            const params = getFFParams();
            const forecastIrr = getForecastIrradiance(params.tau_solar * 3600); // Convert hours to seconds

            computeAndPublish(forecastIrr);
            computeAndStoreRoomDemandForecast();
        }

        function publishRoomTick(payload) {
            const tsNowSec = Math.floor(Date.now() / 1000);
            const tickPayload = { ts: tsNowSec, periodSec: Number(payload?.periodSec || lastPeriodSec || 300) };
            node.send({ topic: node.roomTickTopic, payload: tickPayload });
        }

        // ======================================================================
        // INPUT HANDLER
        // ======================================================================

        node.on("input", (msg) => {
            try {
                const t = (msg.topic || "").trim();

                // DEBUG: Log all heating tick arrivals
                if (t === node.globalTickTopic) {
                    node.log(`[DEBUG] Received ${node.globalTickTopic} - ts=${msg.payload?.ts} periodSec=${msg.payload?.periodSec}`);
                }

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

                        setTimeout(
                            () => {
                                try {
                                    node.log(`[DEBUG] Calling onTick for ${node.name}`);
                                    onTick(msg.payload);
                                    node.log(`[DEBUG] onTick completed for ${node.name}`);
                                    publishRoomTick(msg.payload);
                                    node.log(`[DEBUG] publishRoomTick completed for ${node.name}`);
                                } catch (e) {
                                    node.error(`[mpc-room-adv] Exception in onTick: ${e.message}`, e);
                                    node.error(`[mpc-room-adv] Stack: ${e.stack}`);
                                }
                            },
                            Math.max(0, node.tickDelaySec * 1000)
                        );
                    }
                    return;
                }

                if (t === tRoomTopic && msg.payload != null) {
                    const newTi = parseFloat(msg.payload);
                    const oldTi = Ti;
                    Ti = newTi;

                    // Emergency compute: update Tf setpoint if far from target
                    // (floor node will act on next regular tick)
                    if (Tset != null) {
                        const error = Tset - newTi;
                        const drop = oldTi != null ? oldTi - newTi : 0;

                        // Cooldown: Don't spam (min 60s between)
                        const now = Date.now();
                        const cooldownMs = 60000;
                        if (lastEmergencyTs && now - lastEmergencyTs < cooldownMs) {
                            return;
                        }

                        // Trigger if: error > 1.5 degC OR temp dropped > 0.5 degC
                        if (error > 1.5 || drop > 0.5) {
                            lastEmergencyTs = now;
                            node.log(`[emergency] Ti=${newTi.toFixed(1)} error=${error.toFixed(1)}degC - update Tf setpoint (floor acts on next tick)`);

                            // Check forecast availability before attempting FF calculation
                            const cache = node.context().global.get("forecastCache");
                            let forecastIrr = null;
                            if (cache && cache.irradiance) {
                                const params = getFFParams();
                                forecastIrr = getForecastIrradiance(params.tau_solar * 3600); // Convert hours to seconds
                            } else {
                                // During startup grace period, this is expected - don't complain
                                const timeSinceStartup = Date.now() - nodeStartupTime;
                                if (timeSinceStartup >= STARTUP_GRACE_MS) {
                                    node.log("[mpc-room-adv] Forecast unavailable - using zero FF adjustment");
                                }
                            }

                            computeAndPublish(forecastIrr);
                            // Do NOT publish room tick - let regular tick handle valve timing
                        }
                    }
                    return;
                }
                if (t === spRoomTopic && msg.payload != null) {
                    const newTset = parseFloat(msg.payload);
                    const oldTset = Tset;
                    Tset = newTset;

                    // Emergency compute: if setpoint raised and room cold
                    if (Ti != null && oldTset != null) {
                        const increase = newTset - oldTset;
                        const error = newTset - Ti;

                        const now = Date.now();
                        const cooldownMs = 60000;
                        if (lastEmergencyTs && now - lastEmergencyTs < cooldownMs) {
                            return;
                        }

                        if (increase > 0.5 && error > 1.0) {
                            lastEmergencyTs = now;
                            node.log(`[emergency] Tset raised to ${newTset.toFixed(1)} error=${error.toFixed(1)}degC - update Tf setpoint`);

                            // Check forecast availability before attempting FF calculation
                            const cache = node.context().global.get("forecastCache");
                            let forecastIrr = null;
                            if (cache && cache.irradiance) {
                                const params = getFFParams();
                                forecastIrr = getForecastIrradiance(params.tau_solar * 3600); // Convert hours to seconds
                            } else {
                                // During startup grace period, this is expected - don't complain
                                const timeSinceStartup = Date.now() - nodeStartupTime;
                                if (timeSinceStartup >= STARTUP_GRACE_MS) {
                                    node.log("[mpc-room-adv] Forecast unavailable - using zero FF adjustment");
                                }
                            }

                            computeAndPublish(forecastIrr);
                            // Do NOT publish room tick
                        }
                    }
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

                // FF time lags (from FTxW datastream, coeff=3600 converts to hours)
                if (ffTimeLagsTopic && t === ffTimeLagsTopic + ".1" && msg.payload != null) {
                    if (!isLearningWindowOpen()) {
                        node.debug(`[ff-params] tau_solar ignored outside learning window (${learningWindowStart}:00-${learningWindowEnd}:00)`);
                        return;
                    }
                    tau_solar = parseFloat(msg.payload);
                    node.log(`[ff-params] tau_solar = ${tau_solar.toFixed(1)}h`);
                    saveState();
                    return;
                }
                if (ffTimeLagsTopic && t === ffTimeLagsTopic + ".2" && msg.payload != null) {
                    if (!isLearningWindowOpen()) {
                        node.debug(`[ff-params] tau_thermal ignored outside learning window (${learningWindowStart}:00-${learningWindowEnd}:00)`);
                        return;
                    }
                    tau_thermal = parseFloat(msg.payload);
                    node.log(`[ff-params] tau_thermal = ${tau_thermal.toFixed(1)}h`);
                    saveState();
                    return;
                }

                // FF gains (from FFGxW datastream - read node already applies coefficient 1000)
                if (ffGainsTopic && t === ffGainsTopic + ".1" && msg.payload != null) {
                    if (!isLearningWindowOpen()) {
                        node.debug(`[ff-params] gain_solar ignored outside learning window`);
                        return;
                    }
                    gain_solar = parseFloat(msg.payload);
                    node.log(`[ff-params] gain_solar = ${gain_solar.toFixed(3)}`);
                    saveState();
                    return;
                }
                if (ffGainsTopic && t === ffGainsTopic + ".2" && msg.payload != null) {
                    if (!isLearningWindowOpen()) {
                        node.debug(`[ff-params] gain_temp ignored outside learning window`);
                        return;
                    }
                    gain_temp = parseFloat(msg.payload);
                    node.log(`[ff-params] gain_temp = ${gain_temp.toFixed(3)}`);
                    saveState();
                    return;
                }
                if (ffGainsTopic && t === ffGainsTopic + ".3" && msg.payload != null) {
                    if (!isLearningWindowOpen()) {
                        node.debug(`[ff-params] gain_wind ignored outside learning window`);
                        return;
                    }
                    gain_wind = parseFloat(msg.payload);
                    node.log(`[ff-params] gain_wind = ${gain_wind.toFixed(4)}`);
                    saveState();
                    return;
                }
            } catch (e) {
                node.error(`[mpc-room-adv] Uncaught exception in input handler: ${e.message}`, e);
                node.error(`[mpc-room-adv] Stack: ${e.stack}`);
            }
        });

        node.on("close", () => {
            saveState();
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-mpc-room-advanced", MpcRoomAdvancedNode);
};
