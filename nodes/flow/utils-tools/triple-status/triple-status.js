const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function TripleStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // topics (empty string means disabled)
        node.tItem1 = String(config.tItem1 || config.tSet || "");
        node.tItem2 = String(config.tItem2 || config.tAct || "");
        node.tItem3 = String(config.tItem3 || config.tOut || "");

        // formatting
        node.pItem1 = parseInt(config.pItem1 ?? config.pSet ?? 1, 10);
        node.pItem2 = parseInt(config.pItem2 ?? config.pAct ?? 1, 10);
        node.pItem3 = parseInt(config.pItem3 ?? config.pOut ?? 0, 10);

        node.wItem1 = parseInt(config.wItem1 ?? config.wSet ?? 6, 10);
        node.wItem2 = parseInt(config.wItem2 ?? config.wAct ?? 6, 10);
        node.wItem3 = parseInt(config.wItem3 ?? config.wOut ?? 4, 10);

        node.prefixSpaces = parseInt(config.prefixSpaces ?? 2, 10);
        node.prefixText = String(config.prefixText || "");
        node.debugLog = !!config.debugLog;

        const FIG = "\u2007"; // figure space

        const ctx = node.context();
        let vals = ctx.get("vals") || { item1: null, item2: null, item3: null };

        function padNum(v, width, prec) {
            if (v === null || v === undefined) return "--".padStart(width, FIG);
            const n = Number(v);
            if (Number.isNaN(n)) return "?".padStart(width, FIG);
            const s = prec >= 0 ? n.toFixed(prec) : String(n);
            return s.padStart(width, FIG);
        }

        function renderStatus(updatedKey) {
            const a = padNum(vals.item1, node.wItem1, node.pItem1);
            const b = padNum(vals.item2, node.wItem2, node.pItem2);
            const c = padNum(vals.item3, node.wItem3, node.pItem3);
            const prefixFig = FIG.repeat(Math.max(0, node.prefixSpaces | 0));
            const text = `${prefixFig}${node.prefixText}${a}  ${b}  ${c}`;
            const color = updatedKey ? "green" : "grey";
            node.status({ fill: color, shape: "dot", text });
            if (updatedKey) setTimeout(() => node.status({ fill: "grey", shape: "dot", text }), 700);
        }

        renderStatus(null);

        node.on("input", (msg) => {
            let touched = null;
            const t = (msg.topic || "").toString();

            // Only process if topic matches one of the configured (non-empty) topics
            if (node.tItem1 && t === node.tItem1) {
                vals.item1 = msg.payload;
                touched = "item1";
            } else if (node.tItem2 && t === node.tItem2) {
                vals.item2 = msg.payload;
                touched = "item2";
            } else if (node.tItem3 && t === node.tItem3) {
                vals.item3 = msg.payload;
                touched = "item3";
            } else {
                // No match - ignore this message completely
                return;
            }

            // Debug logging if enabled
            if (node.debugLog) {
                const items = [
                    node.tItem1 ? `${node.tItem1}=${vals.item1}` : null,
                    node.tItem2 ? `${node.tItem2}=${vals.item2}` : null,
                    node.tItem3 ? `${node.tItem3}=${vals.item3}` : null
                ]
                    .filter((x) => x)
                    .join(", ");
                node.log(`Received topic="${t}" payload=${msg.payload} → [${items}]`);
            }

            // Only reached if touched is set - flash green even if value unchanged
            ctx.set("vals", vals);
            renderStatus(touched);
        });

        node.on("close", () => node.status({}));
    }

    RED.nodes.registerType("uniflex-triple-status", TripleStatusNode);
};
