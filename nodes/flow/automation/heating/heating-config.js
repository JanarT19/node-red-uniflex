const ts = require("../../core/lib/timestamp.js");
// heating-config.js
// Node-RED config node: shared heating/feedforward settings
// Purpose: Avoid duplicating feedforward settings across 18+ floor loops.
// Data source: iolayer topics from forecast-publisher (FCTW.1, FCWW.1, etc.)

module.exports = function (RED) {
    function HeatingConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Feedforward settings
        node.ffEnable = !!config.ffEnable;
        node.ffHorizon1 = Number(config.ffHorizon1 ?? 6);
        node.ffHorizon2 = Number(config.ffHorizon2 ?? 12);
        node.ffGainTout = Number(config.ffGainTout ?? 0.25);
        node.ffGainWind = Number(config.ffGainWind ?? 0.02);
        node.ffTbalance = Number(config.ffTbalance ?? 15);

        // Iolayer topic prefixes (data from forecast-publisher)
        node.ffToutTopicPrefix = config.ffToutTopicPrefix || "FCTW";
        node.ffWindTopicPrefix = config.ffWindTopicPrefix || "FCWW";

        // FF param learning window: only accept FT/FG updates within this local-time window.
        // Keeps iolayer restarts from overwriting persisted learned params with stale/reset values.
        // Set to -1/-1 to disable (always accept).
        node.learningWindowStart = parseInt(config.learningWindowStart ?? 2);
        node.learningWindowEnd = parseInt(config.learningWindowEnd ?? 4);

        // Balance temperature: outdoor temp at which internal gains offset heat losses -> no heating.
        // Used by mpc-room-advanced to subtract internal gains from demand estimate.
        node.Tbalance = Number(config.Tbalance ?? 15.0);

        node.warn(`[heating-config:${config.name}] DEPRECATED: migrate settings to uniflex-thermal-model-config ` + `and link thermalModel on mpc-room / floor-loop nodes`);
        node.log(`[heating-config:${config.name}] Initialized: ff=${node.ffEnable}, topics=${node.ffToutTopicPrefix}/${node.ffWindTopicPrefix}`);
    }

    RED.nodes.registerType("uniflex-heating-config", HeatingConfigNode);
};
