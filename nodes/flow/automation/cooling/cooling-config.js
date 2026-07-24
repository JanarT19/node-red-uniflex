const ts = require("../../core/lib/timestamp.js");
// cooling-config.js
// Shared IDU cooling thresholds for all idu-cooling-control nodes in a flow.

module.exports = function (RED) {
    function CoolingConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        node.name = config.name || "Cooling config";
        node.hysteresisC = Math.max(0, Number(config.hysteresisC ?? 0.3));
        // Global ECO inhibit polarity for all linked IDU nodes (exact match).
        // ECO-active (cooling inhibited) is signalled by value 1.
        node.ecoActiveValue = Number(config.ecoActiveValue ?? 1);
        node.globalEnableTopic = (config.globalEnableTopic || "CGOLS.1").trim();
        node.coolingEnabled = true;
        // No global topic -> gate not used; with topic, wait for first CGOLS read.
        node.globalEnableKnown = !node.globalEnableTopic;
        node._iduListeners = new Set();

        node.applyGlobalDisable = function (payload, source) {
            if (payload == null || payload === "") return null;
            const n = Number(payload);
            let disabled;
            if (Number.isFinite(n)) {
                disabled = n >= 1;
            } else {
                disabled = !!payload;
            }
            const enabled = !disabled;
            const wasKnown = node.globalEnableKnown;
            node.globalEnableKnown = true;
            if (!wasKnown) {
                node.coolingEnabled = enabled;
                node.log(`[cooling-config:${node.name}] CGOLS ${enabled ? "allow cooling" : "cooling DISABLED all IDUs"}` + (source ? ` (${source})` : ""));
                node._iduListeners.forEach((fn) => {
                    try {
                        fn(enabled);
                    } catch (err) {
                        node.error(`cooling listener error: ${err.message || err}`);
                    }
                });
                return enabled;
            }
            return node.setCoolingEnabled(enabled, source);
        };

        node.setCoolingEnabled = function (enabled, source) {
            const val = !!enabled;
            if (node.coolingEnabled === val) {
                return val;
            }
            node.coolingEnabled = val;
            node.log(`[cooling-config:${node.name}] CGOLS ${val ? "allow cooling" : "cooling DISABLED all IDUs"}` + (source ? ` (${source})` : ""));
            node._iduListeners.forEach((fn) => {
                try {
                    fn(val);
                } catch (err) {
                    node.error(`cooling listener error: ${err.message || err}`);
                }
            });
            return val;
        };

        node.registerIduListener = function (fn) {
            if (typeof fn !== "function") {
                return function () {};
            }
            node._iduListeners.add(fn);
            return function () {
                node._iduListeners.delete(fn);
            };
        };

        node.log(`[cooling-config:${node.name}] hysteresis=+-${node.hysteresisC.toFixed(1)}C ` + `ecoActive=${node.ecoActiveValue} globalTopic=${node.globalEnableTopic}`);

        node.on("close", () => {
            node._iduListeners.clear();
        });
    }

    RED.nodes.registerType("uniflex-cooling-config", CoolingConfigNode);
};
