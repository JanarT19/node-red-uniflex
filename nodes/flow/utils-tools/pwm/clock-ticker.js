const ts = require("../../core/lib/timestamp.js");
module.exports = function (RED) {
    function ClockTickerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        const allowed = new Set([60, 300, 600, 1200, 1800, 3600]);
        let periodSec = Number(config.periodSec || 1800);

        // Validate period.
        if (!allowed.has(periodSec)) {
            node.error(`Invalid periodSec ${periodSec}, defaulting to 1800s`);
            node.status({ fill: "red", shape: "ring", text: `Invalid periodSec ${periodSec}, defaulting to 1800s` });
            periodSec = 1800;
        }

        const outputTopic = config.outputTopic || "heating/tick";

        let timer = null;
        const P = periodSec * 1000;

        // Compute next tick aligned to local wall-clock boundaries measured from local midnight.
        function scheduleNext(fromMs) {
            if (timer) clearTimeout(timer);

            // Determine local midnight for the day of 'fromMs'
            const d = new Date(fromMs);
            const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

            // Number of periods elapsed since midnight
            const elapsed = fromMs - midnight;
            const periodsSinceMidnight = Math.ceil(elapsed / P);
            const next = midnight + periodsSinceMidnight * P;

            const delay = Math.max(0, next - Date.now());
            node.status({
                fill: "green",
                shape: "dot",
                text: `Next tick at ${new Date(next).toLocaleTimeString("en-GB", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false
                })}`
            });

            timer = setTimeout(() => fire(next), delay);
        }

        function fire(t0) {
            node.send({ topic: outputTopic, payload: { ts: Math.floor(t0 / 1000), periodSec } });
            scheduleNext(t0 + P);
        }

        scheduleNext(Date.now());

        node.on("close", () => {
            if (timer) clearTimeout(timer);
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-clock-ticker", ClockTickerNode);
};
