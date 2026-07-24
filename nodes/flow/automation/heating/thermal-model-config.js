const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    const fs = require("fs");
    const path = require("path");

    // Optional: js-yaml for YAML export (graceful fallback to JSON if not available)
    let yaml;
    try {
        yaml = require("js-yaml");
    } catch (e) {
        yaml = null;
    }

    const CONFIG_VERSION = "1.0.0";

    function ThermalModelConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Store all config values for access by other nodes
        node.name = config.name || "Thermal Model";

        // Building thermal mass (validated, rarely change)
        node.Cf = parseFloat(config.Cf) || 80.0; // kWh/°C - Floor slab
        node.Ci = parseFloat(config.Ci) || 43.3; // kWh/°C - Air + light structures
        node.Uf = parseFloat(config.Uf) || 2.0; // kW/°C - Floor-to-air transfer

        // Envelope (may need seasonal tuning)
        node.Uenv_base = parseFloat(config.Uenv_base) || 0.45; // kW/°C - Base loss (at Tbalance)
        node.k_wind = parseFloat(config.k_wind) || 0.0211; // kW/°C/ms - Wind effect
        node.k_temp = parseFloat(config.k_temp) || 0.011; // kW/°C² - Additional loss per °C below Tbalance
        node.Q_solar_max = parseFloat(config.Q_solar_max) || 7.09; // kW - Max solar gain
        node.Tbalance = parseFloat(config.Tbalance) || 15; // °C - Balance temperature (no heating needed above this)

        // Heat distribution limits
        node.Q_floor_max = parseFloat(config.Q_floor_max) || 20.0; // kW
        node.Q_vent_max = parseFloat(config.Q_vent_max) || 2.2; // kW
        node.Q_distribution = node.Q_floor_max + node.Q_vent_max; // Total usable
        node.floor_lead_hours = parseFloat(config.floor_lead_hours) || 2.0; // h - pipe-to-surface lag for solar FF

        // Heat sources - HP
        node.hp_Qmax = parseFloat(config.hp_Qmax) || 15.0; // kW at reference temp
        node.hp_copT1 = parseFloat(config.hp_copT1) || -10; // °C
        node.hp_copV1 = parseFloat(config.hp_copV1) || 2.0; // COP at T1
        node.hp_copT2 = parseFloat(config.hp_copT2) || 10; // °C (reference)
        node.hp_copV2 = parseFloat(config.hp_copV2) || 3.1; // COP at T2

        // COP plane: COP = cop_a + cop_b * Tout + cop_c * Power
        // Fitted from real HP measurements at different outdoor temps and power levels.
        // Set cop_a=0 to fall back to the old copT1/copV1/copT2/copV2 linear model.
        node.cop_a = parseFloat(config.cop_a) || 0;
        node.cop_b = parseFloat(config.cop_b) || 0;
        node.cop_c = parseFloat(config.cop_c) || 0;

        // Heat sources - Gas
        node.gas_Qmax = parseFloat(config.gas_Qmax) || 28.0; // kW
        node.gas_efficiency = parseFloat(config.gas_efficiency) || 0.95;

        // Weather feedforward (building-wide, used by floor-loop)
        node.ffEnable = !!config.ffEnable;
        node.ffHorizon1 = Number(config.ffHorizon1 ?? 6);
        node.ffHorizon2 = Number(config.ffHorizon2 ?? 12);
        node.ffGainTout = Number(config.ffGainTout ?? 0.25);
        node.ffGainWind = Number(config.ffGainWind ?? 0.02);
        node.ffToutTopicPrefix = config.ffToutTopicPrefix || "FCTW";
        node.ffWindTopicPrefix = config.ffWindTopicPrefix || "FCWW";

        // FF param learning window (used by mpc-room-advanced)
        node.learningWindowStart = parseInt(config.learningWindowStart ?? 2);
        node.learningWindowEnd = parseInt(config.learningWindowEnd ?? 4);

        // Derived values (calculated)
        node.C_total = node.Cf + node.Ci;
        node.tau_floor = node.Cf / node.Uf;
        node.tau_air = node.Ci / node.Uf;
        node.Q_internal = node.Uenv_base * (20 - node.Tbalance); // kW - constant internal gains (appliances, people, etc.)

        // Helper: Get COP at given outdoor temperature and power (plane model or linear fallback)
        node.getCopAtTemp = function (Tout, Power) {
            if (node.cop_a > 0 && Power != null) {
                return Math.max(1.0, node.cop_a + node.cop_b * Tout + node.cop_c * Power);
            }
            // Fallback: old linear interpolation (outdoor temp only)
            if (node.hp_copT1 === node.hp_copT2) return node.hp_copV1;
            const slope = (node.hp_copV2 - node.hp_copV1) / (node.hp_copT2 - node.hp_copT1);
            const cop = node.hp_copV1 + slope * (Tout - node.hp_copT1);
            return Math.max(1.0, cop);
        };

        // Helper: Get HP capacity at given outdoor temperature (derated by COP)
        node.getHpCapacityAtTemp = function (Tout) {
            const copNominal = node.hp_copV2;
            if (node.cop_a > 0) {
                // Use plane COP at nominal power for derating
                const copAtNominal = Math.max(1.0, node.cop_a + node.cop_b * Tout + node.cop_c * node.hp_Qmax);
                const derateFactor = copAtNominal / copNominal;
                return node.hp_Qmax * Math.min(1.0, derateFactor);
            }
            const copCurrent = node.getCopAtTemp(Tout);
            const derateFactor = copCurrent / copNominal;
            return node.hp_Qmax * Math.min(1.0, derateFactor);
        };

        // Helper: Get effective envelope loss at given outdoor temp and wind speed
        node.getUenvEffective = function (Tout, wind) {
            const tempEffect = node.k_temp * Math.max(0, node.Tbalance - Tout);
            return node.Uenv_base + tempEffect + node.k_wind * (wind || 0);
        };

        // Backward-compatible helper (wind only, no temp effect)
        node.getUenvAtWind = function (wind) {
            return node.Uenv_base + node.k_wind * wind;
        };

        // Export to YAML file (falls back to JSON if js-yaml not available)
        node.exportToYaml = function (filepath) {
            const data = node.getExportData();
            let content;

            if (yaml) {
                const header = generateYamlHeader(node);
                content = header + yaml.dump(data, { indent: 2, lineWidth: 120 });
            } else {
                // Fallback to JSON
                content = JSON.stringify(data, null, 2);
                filepath = filepath.replace(/\.yaml$/, ".json");
            }

            fs.writeFileSync(filepath, content, "utf8");
            return filepath;
        };

        // Import from YAML/JSON file
        node.importFromYaml = function (filepath) {
            const content = fs.readFileSync(filepath, "utf8");
            let data;

            if (filepath.endsWith(".json") || !yaml) {
                data = JSON.parse(content);
            } else {
                data = yaml.load(content);
            }
            return data;
        };

        // Get data for export
        node.getExportData = function () {
            return {
                name: node.name,
                version: CONFIG_VERSION,
                exported: new Date().toISOString(),

                // Building
                Cf: node.Cf,
                Ci: node.Ci,
                Uf: node.Uf,

                // Envelope
                Uenv_base: node.Uenv_base,
                k_wind: node.k_wind,
                k_temp: node.k_temp,
                Q_solar_max: node.Q_solar_max,
                Tbalance: node.Tbalance,

                // Weather feedforward
                ffEnable: node.ffEnable,
                ffHorizon1: node.ffHorizon1,
                ffHorizon2: node.ffHorizon2,
                ffGainTout: node.ffGainTout,
                ffGainWind: node.ffGainWind,
                ffToutTopicPrefix: node.ffToutTopicPrefix,
                ffWindTopicPrefix: node.ffWindTopicPrefix,
                learningWindowStart: node.learningWindowStart,
                learningWindowEnd: node.learningWindowEnd,

                // Distribution
                Q_floor_max: node.Q_floor_max,
                Q_vent_max: node.Q_vent_max,

                // HP
                hp_Qmax: node.hp_Qmax,
                hp_cop_points: [
                    [node.hp_copT1, node.hp_copV1],
                    [node.hp_copT2, node.hp_copV2]
                ],

                // Gas
                gas_Qmax: node.gas_Qmax,
                gas_efficiency: node.gas_efficiency,

                // History (user can add notes)
                history: []
            };
        };

        // Log on creation
        node.log(
            `[thermal-model-config:${node.name}] Loaded: ` +
                `Cf=${node.Cf} Ci=${node.Ci} Uf=${node.Uf} | ` +
                `Uenv=${node.Uenv_base} k_wind=${node.k_wind} k_temp=${node.k_temp} Tbal=${node.Tbalance}°C Q_int=${node.Q_internal.toFixed(2)}kW | ` +
                `HP=${node.hp_Qmax}kW Gas=${node.gas_Qmax}kW | ` +
                `COP_plane=${node.cop_a > 0 ? `${node.cop_a}+${node.cop_b}*Tout+${node.cop_c}*P` : "off (linear)"} | ` +
                `Distribution=${node.Q_distribution.toFixed(1)}kW | ` +
                `FF=${node.ffEnable ? "on" : "off"} learn=${node.learningWindowStart}-${node.learningWindowEnd}h`
        );
    }

    // Generate YAML header with comments and derived values
    function generateYamlHeader(node) {
        const now = new Date().toISOString().replace("T", " ").substring(0, 19);
        const hp_cap_minus10 = node.getHpCapacityAtTemp(-10).toFixed(1);
        const hp_cap_0 = node.getHpCapacityAtTemp(0).toFixed(1);
        const Uenv_5ms = node.getUenvAtWind(5).toFixed(3);
        const Uenv_10ms = node.getUenvAtWind(10).toFixed(3);
        const Uenv_at_0C = node.getUenvEffective(0, 0).toFixed(3);
        const Uenv_at_m10C = node.getUenvEffective(-10, 0).toFixed(3);
        const tau_house_calm = (node.C_total / node.Uenv_base).toFixed(0);
        const tau_house_wind = (node.C_total / node.getUenvAtWind(10)).toFixed(0);
        const Q_internal = node.Q_internal.toFixed(2);

        return `# ============================================================
# Thermal Model Configuration: ${node.name}
# Generated: ${now}
# Config Version: ${CONFIG_VERSION}
# ============================================================
#
# PARAMETER GUIDE:
#   Cf, Ci, Uf     - Building physics (rarely change)
#   Uenv, k_wind   - Tune if winter predictions drift
#   Q_solar_max    - Tune if summer predictions drift
#   Q_floor/vent   - Heat distribution capacity
#   hp/gas         - Update if equipment changes
#
# DERIVED VALUES (calculated from above):
#   C_total     = Cf + Ci           = ${node.C_total.toFixed(1)} kWh/°C
#   tau_floor   = Cf / Uf           = ${node.tau_floor.toFixed(1)} h
#   tau_air     = Ci / Uf           = ${node.tau_air.toFixed(1)} h
#   tau_house (calm)    = C_total / Uenv = ${tau_house_calm} h
#   tau_house (10 m/s)  = C_total / ${Uenv_10ms} = ${tau_house_wind} h
#
#   Uenv @ 5 m/s  = ${Uenv_5ms} kW/°C
#   Uenv @ 10 m/s = ${Uenv_10ms} kW/°C
#   Uenv @ 0°C (calm)  = ${Uenv_at_0C} kW/°C
#   Uenv @ -10°C (calm) = ${Uenv_at_m10C} kW/°C
#   Tbalance       = ${node.Tbalance} °C
#   Q_internal     = ${Q_internal} kW (derived from Uenv × (20 − Tbalance))
#
#   HP capacity @ -10°C = ${hp_cap_minus10} kW
#   HP capacity @   0°C = ${hp_cap_0} kW
#   HP capacity @ +10°C = ${node.hp_Qmax.toFixed(1)} kW (nominal)
#
#   Q_distribution = Q_floor + Q_vent = ${node.Q_distribution.toFixed(1)} kW
#
# ============================================================

`;
    }

    RED.nodes.registerType("uniflex-thermal-model-config", ThermalModelConfigNode, {
        category: "config"
    });

    // Admin endpoint for export/import
    RED.httpAdmin.post("/thermal-model-config/:id/export", function (req, res) {
        const nodeId = req.params.id;
        const node = RED.nodes.getNode(nodeId);

        if (!node) {
            res.status(404).json({ error: "Node not found" });
            return;
        }

        try {
            const backupDir = path.join(RED.settings.userDir, "backups");
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
            const filename = `thermal-model-${node.name.replace(/[^a-zA-Z0-9]/g, "_")}_${timestamp}.yaml`;
            const filepath = path.join(backupDir, filename);

            node.exportToYaml(filepath);
            res.json({ success: true, path: filepath, filename: filename });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
