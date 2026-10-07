const http = require("http");
const fs = require("fs").promises;
const path = require("path");

module.exports = function (RED) {
    function DiagramCreatorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.chartType = config.chartType || "line"; // "line" or "timeline"
        node.outputPath = config.outputPath || "/tmp/diagram.json";
        node.settingsPath = (config.settingsPath || "").trim(); // If set, generates settings file
        node.rangeMode = config.rangeMode || "fixed";
        node.rangeAnchorTitle = (config.rangeAnchorTitle || "").trim();
        node.startOffset = parseInt(config.startOffset) || -24;
        node.endOffset = parseInt(config.endOffset) || 48;
        node.stepMinutes = parseInt(config.stepMinutes) || 15;
        node.series = config.series || [];
        node.timelineSeries = config.timelineSeries || [];
        // Chart styling options
        node.chartWidth = parseInt(config.chartWidth) || 1000;
        node.chartHeight = parseInt(config.chartHeight) || 400;
        node.vAxisTitle = config.vAxisTitle || "";
        node.hAxisFormat = config.hAxisFormat || "HH:mm";
        node.legendPosition = config.legendPosition || "top";
        node.backgroundColor = config.backgroundColor || "#ffffff";
        node.gridlineColor = config.gridlineColor || "#bbbbbb";
        node.gridlineCount = parseInt(config.gridlineCount) || 48;
        node.showCurrentTime = config.showCurrentTime !== false;
        node.currentTimeColor = config.currentTimeColor || "#000000";
        node.currentTimeWidth = parseInt(config.currentTimeWidth) || 2;
        node.enableLogging = config.enableLogging !== false;

        const VERSION = "0.3.1-plan-cover";
        const log = (msg) => node.enableLogging && node.log(`[diagram-creator v${VERSION}] ${msg}`);
        const warn = (msg) => node.warn(`[diagram-creator v${VERSION}] ${msg}`);
        const err = (msg) => node.error(`[diagram-creator v${VERSION}] ${msg}`);

        function makeRequest(url, timeoutMs) {
            return new Promise((resolve, reject) => {
                const req = http.get(url, { timeout: timeoutMs }, (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            reject(new Error(`Failed to parse JSON: ${e.message}`));
                        }
                    });
                });
                req.on("error", reject);
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("Request timeout"));
                });
            });
        }

        function endFromLatest(latestTs) {
            const d = new Date(latestTs * 1000);
            // Set to 01:00 local time (next day if latest is after 01:00)
            d.setHours(1, 0, 0, 0);
            let endTs = Math.floor(d.getTime() / 1000);
            if (latestTs > endTs) {
                d.setDate(d.getDate() + 1);
                endTs = Math.floor(d.getTime() / 1000);
            }
            return endTs;
        }

        // Format timestamp as ISO string for timeline charts (without timezone, matches Python format)
        function toLocalISOString(ts) {
            const d = new Date(ts * 1000);
            const pad = (n) => n.toString().padStart(2, "0");
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }

        // Format timestamp for Google Charts datetime column in line charts
        // Use ISO string without timezone (e.g., "2026-02-06T01:00:00")
        function toGoogleChartsDate(ts) {
            const d = new Date(ts * 1000);
            const pad = (n) => n.toString().padStart(2, "0");
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }

        // Validate hex color string - must be #RGB or #RRGGBB format
        function isValidHexColor(color) {
            if (!color || typeof color !== "string") return false;
            return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(color);
        }

        // Generate chart settings object based on node configuration
        // Matches the format expected by webui renderer (Google Charts options)
        function generateSettings() {
            if (node.chartType === "timeline") {
                // Timeline chart settings (onoff.settings.json format).
                // Three rows plus the time axis fit in about 190 px. A taller chart
                // leaves an empty band under the last row.
                const timelineRows = [];
                for (const s of node.timelineSeries || []) {
                    const label = (s.rowLabel || s.title || "").trim();
                    if (label && timelineRows.indexOf(label) < 0) timelineRows.push(label);
                }
                const autoHeight = 32 + timelineRows.length * 52;
                const settings = {
                    width: node.chartWidth,
                    height: Math.max(node.chartHeight || 0, autoHeight),
                    backgroundColor: node.backgroundColor,
                    fontSize: 16,
                    hAxis: {
                        format: node.hAxisFormat,
                        gridlines: {
                            count: node.gridlineCount,
                            color: node.gridlineColor || "#bbbbbb"
                        },
                        minorGridlines: { count: 0 }
                    },
                    timeline: {
                        rowLabelStyle: { fontSize: 16, color: "#000000" },
                        barLabelStyle: { fontSize: 12 },
                        groupByRowLabel: true,
                        colorByRowLabel: true,
                        alternatingRowStyle: true,
                        showRowLabels: true
                    },
                    avoidOverlappingGridLines: true
                };

                // Build colors array from timeline series (if style contains color)
                const colors = [];
                for (const s of node.timelineSeries) {
                    if (s.style) {
                        // Extract color from style string, e.g., "color: #3366cc" or just "#3366cc"
                        // Only match valid 3 or 6 character hex colors
                        const colorMatch = s.style.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/);
                        if (colorMatch && isValidHexColor(colorMatch[0])) {
                            colors.push(colorMatch[0]);
                        }
                    }
                }
                if (colors.length > 0) {
                    settings.colors = colors;
                }

                return settings;
            } else {
                // Line chart settings (prices.settings.json format)
                const settings = {
                    width: node.chartWidth,
                    height: node.chartHeight,
                    backgroundColor: node.backgroundColor,
                    chartArea: { left: 150, top: 25, right: 0, bottom: 8, width: "90%" },
                    vAxis: {
                        gridlines: { count: 24, color: node.gridlineColor || "#bbbbbb" },
                        minorGridlines: { count: 0 },
                        format: "#",
                        title: node.vAxisTitle,
                        textStyle: { fontSize: 20 }
                    },
                    hAxis: {
                        gridlines: {
                            count: node.gridlineCount,
                            color: node.gridlineColor || "#bbbbbb"
                        },
                        textPosition: "none"
                    },
                    annotations: {
                        style: "line",
                        stem: { color: "#010101" }
                    },
                    legend: {
                        position: node.legendPosition,
                        maxLines: 7,
                        textStyle: { fontSize: 18 }
                    },
                    areaOpacity: 0,
                    connectSteps: true,
                    isStacked: false
                };

                // Build series-specific options (lineWidth, areaOpacity per series)
                const seriesOptions = {};
                const colors = [];
                const defaultPalette = ["#fabf99", "#83d2f1", "#ff0000", "#0000ff", "#ee8888", "#8888ee", "#88FF88"];

                node.series
                    .filter((s) => s.title)
                    .forEach((s, idx) => {
                        const opts = {};
                        // Default lineWidth of 4 for first 4 series, 2 for others (matching original settings)
                        opts.lineWidth = s.lineWidth && !isNaN(s.lineWidth) ? s.lineWidth : idx < 4 ? 4 : 2;

                        // Area opacity from series config (0 = no fill, 0.2 = light fill, 1.0 = solid)
                        if (s.opacity && !isNaN(s.opacity) && s.opacity > 0) {
                            opts.areaOpacity = s.opacity;
                        }

                        seriesOptions[idx] = opts;

                        // Collect colors - validate hex format, fallback to palette if invalid
                        const color = isValidHexColor(s.color) ? s.color : defaultPalette[idx % defaultPalette.length];
                        colors.push(color);
                    });

                if (Object.keys(seriesOptions).length > 0) {
                    settings.series = seriesOptions;
                }

                if (colors.length > 0) {
                    settings.colors = colors;
                }

                // Current time marker settings for webui
                if (node.showCurrentTime) {
                    settings.currentTime = {
                        enabled: true,
                        color: node.currentTimeColor || "#000000",
                        width: node.currentTimeWidth || 2
                    };
                }

                return settings;
            }
        }

        node.on("input", async (msg, send, done) => {
            try {
                node.status({ fill: "blue", shape: "dot", text: "generating..." });

                const now = Math.floor(Date.now() / 1000);
                const stepSeconds = node.stepMinutes * 60;
                let startTs, endTs;

                if (node.rangeMode === "anchor" && node.rangeAnchorTitle) {
                    const wideStart = now - 24 * 3600;
                    const wideEnd = now + 96 * 3600;
                    const params = new URLSearchParams({
                        title: node.rangeAnchorTitle,
                        start: wideStart.toString(),
                        end: wideEnd.toString()
                    });
                    const url = `http://localhost:80/calendar?${params.toString()}`;
                    const resp = await makeRequest(url, 8000);

                    let latestTs = -1;
                    if (Array.isArray(resp)) {
                        resp.forEach((p) => {
                            if (p.timestamp !== undefined && p.timestamp > latestTs) latestTs = p.timestamp;
                        });
                    }

                    if (latestTs < 0) {
                        warn(`No data for anchor "${node.rangeAnchorTitle}", falling back to fixed offsets`);
                        startTs = now + node.startOffset * 3600;
                        endTs = now + node.endOffset * 3600;
                    } else {
                        endTs = endFromLatest(latestTs);
                        startTs = endTs - 48 * 3600;
                        log(`Anchor "${node.rangeAnchorTitle}" latest=${new Date(latestTs * 1000).toISOString()} -> 48h window ending ${new Date(endTs * 1000).toISOString()}`);
                    }
                } else {
                    startTs = now + node.startOffset * 3600;
                    endTs = now + node.endOffset * 3600;
                }

                // Align start to step boundary for clean timestamps (e.g. :00, :15, :30, :45)
                startTs = Math.floor(startTs / stepSeconds) * stepSeconds;

                log(`Generating ${node.chartType} diagram from ${new Date(startTs * 1000).toISOString()} to ${new Date(endTs * 1000).toISOString()}`);

                let output;
                let rowCount = 0;

                // ================================================================
                // TIMELINE CHART (onoff events with start/end)
                // ================================================================
                if (node.chartType === "timeline") {
                    // Timeline format: [Role, Name (kWh label), Style, Start, End]
                    // Event value is planned or actual kWh ("1.5"). Non-zero means the block is ON.
                    const columns = [
                        { type: "string", id: "Role" },
                        { type: "string", id: "Name" }, // Will contain kWh value
                        { role: "style" },
                        { type: "datetime", label: "Start" },
                        { type: "datetime", label: "End" }
                    ];

                    const rows = [];
                    const bars = [];
                    const seriesToQuery = node.timelineSeries || [];
                    const rowLabels = [];
                    const rowHasSpan = {};

                    // Add invisible placeholder rows at start and end to define chart time range
                    // These use the first series' row label with opacity: 0
                    const firstRowLabel = seriesToQuery.length > 0 ? seriesToQuery[0].rowLabel || seriesToQuery[0].title || "Range" : "Range";
                    const startISORng = toLocalISOString(startTs);
                    const endISORng = toLocalISOString(endTs);
                    rows.push([firstRowLabel, "", "opacity: 0", startISORng, startISORng]);
                    rows.push([firstRowLabel, "", "opacity: 0", endISORng, endISORng]);

                    for (const s of seriesToQuery) {
                        if (!s.title) continue;

                        const rowLabel = s.rowLabel || s.title;
                        if (rowLabels.indexOf(rowLabel) < 0) rowLabels.push(rowLabel);
                        // Format style for Google Charts: if just a color like "#ff0000", convert to CSS style
                        let style = s.style || null;
                        if (style && /^#[0-9a-fA-F]{3,6}$/.test(style.trim())) {
                            style = `color: ${style.trim()}`;
                        }

                        try {
                            // Query with events=true to get properly paired start/end events
                            const params = new URLSearchParams({
                                title: s.title,
                                start: startTs.toString(),
                                end: endTs.toString(),
                                events: "true"
                            });
                            const url = `http://localhost:80/calendar?${params.toString()}`;
                            const resp = await makeRequest(url, 8000);

                            if (Array.isArray(resp) && resp.length > 0) {
                                // Debug: log first event to see field names
                                log(`Timeline ${s.title}: ${resp.length} events from API, sample: ${JSON.stringify(resp[0])}`);

                                // Helper for local time format
                                const fmtTs = (ts) => new Date(ts * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });

                                // With events=true, API returns events with start/end or ts1/ts2
                                let eventCount = 0;
                                for (const evt of resp) {
                                    let evtStart, evtEnd;

                                    // Try various field name combinations the API might use
                                    if (evt.start !== undefined && evt.end !== undefined) {
                                        evtStart = evt.start;
                                        evtEnd = evt.end;
                                    } else if (evt.ts1 !== undefined && evt.ts2 !== undefined) {
                                        // Backend might use ts1/ts2
                                        evtStart = evt.ts1;
                                        evtEnd = evt.ts2;
                                    } else if (evt.timestamp !== undefined && evt.mid !== undefined && evt.mid !== null) {
                                        // mid might be end timestamp in some formats
                                        evtStart = Math.min(evt.timestamp, evt.mid);
                                        evtEnd = Math.max(evt.timestamp, evt.mid);
                                    } else if (evt.timestamp !== undefined) {
                                        // Point event - show as 1-hour bar
                                        evtStart = evt.timestamp;
                                        evtEnd = evt.timestamp + 3600;
                                    } else {
                                        log(`Timeline ${s.title}: skipping event with unknown format: ${JSON.stringify(evt)}`);
                                        continue;
                                    }

                                    // Only include events that overlap with our time range
                                    if (evtEnd < startTs || evtStart > endTs) continue;

                                    // Log raw event timestamps before clipping
                                    log(`  ${s.title} event: ${fmtTs(evtStart)} (ts=${evtStart}) -> ${fmtTs(evtEnd)} (ts=${evtEnd})`);

                                    // Clip to time range
                                    evtStart = Math.max(evtStart, startTs);
                                    evtEnd = Math.min(evtEnd, endTs);

                                    // Value is kWh (number or numeric string). Legacy "1.2 kWh (...)" still parses.
                                    let displayValue = "";
                                    if (evt.value !== undefined && evt.value !== null && evt.value !== "") {
                                        const num = typeof evt.value === "number" ? evt.value : parseFloat(String(evt.value).trim());
                                        if (Number.isFinite(num)) {
                                            displayValue = num.toFixed(1) + " kWh";
                                        } else if (typeof evt.value === "string") {
                                            displayValue = evt.value;
                                        }
                                    }

                                    if (evtEnd > evtStart) {
                                        bars.push({
                                            rowLabel: rowLabel,
                                            title: s.title,
                                            displayValue: displayValue,
                                            style: style,
                                            start: evtStart,
                                            end: evtEnd
                                        });
                                        eventCount++;
                                    }
                                }
                                log(`Timeline: ${eventCount} events for ${s.title} (${rowLabel})`);
                            } else {
                                log(`Timeline: no events for ${s.title}`);
                            }
                        } catch (e) {
                            warn(`Failed to load timeline series ${s.title}: ${e.message}`);
                        }
                    }

                    // Plan (_ena) yields to actual (_run) on the same row. Google Charts
                    // opens a second track for any time overlap, which pushes later rows
                    // (SaunaPreheat) out of the fixed chart height. A light plan bar
                    // remains only in the minutes the actual run does not occupy.
                    function mergeSpans(spans) {
                        const sorted = spans.filter((s) => s[1] > s[0]).sort((a, b) => a[0] - b[0]);
                        const out = [];
                        for (let i = 0; i < sorted.length; i++) {
                            const s = sorted[i];
                            if (out.length === 0 || s[0] > out[out.length - 1][1]) {
                                out.push([s[0], s[1]]);
                            } else if (s[1] > out[out.length - 1][1]) {
                                out[out.length - 1][1] = s[1];
                            }
                        }
                        return out;
                    }

                    function subtractSpans(start, end, covers) {
                        let pieces = [[start, end]];
                        for (let i = 0; i < covers.length; i++) {
                            const cs = covers[i][0];
                            const ce = covers[i][1];
                            const next = [];
                            for (let p = 0; p < pieces.length; p++) {
                                const ps = pieces[p][0];
                                const pe = pieces[p][1];
                                if (ce <= ps || cs >= pe) {
                                    next.push([ps, pe]);
                                    continue;
                                }
                                if (cs > ps) next.push([ps, cs]);
                                if (ce < pe) next.push([ce, pe]);
                            }
                            pieces = next;
                        }
                        return pieces.filter((s) => s[1] > s[0]);
                    }

                    const byRow = {};
                    for (let i = 0; i < bars.length; i++) {
                        const b = bars[i];
                        if (!byRow[b.rowLabel]) byRow[b.rowLabel] = [];
                        byRow[b.rowLabel].push(b);
                    }

                    for (let r = 0; r < rowLabels.length; r++) {
                        const label = rowLabels[r];
                        const group = byRow[label] || [];
                        const actualSpans = [];
                        for (let i = 0; i < group.length; i++) {
                            if (/_run$/.test(group[i].title) && group[i].end > group[i].start) {
                                actualSpans.push([group[i].start, group[i].end]);
                            }
                        }
                        const covers = mergeSpans(actualSpans);
                        for (let i = 0; i < group.length; i++) {
                            const b = group[i];
                            if (/_ena$/.test(b.title) && covers.length > 0) {
                                const pieces = subtractSpans(b.start, b.end, covers);
                                if (pieces.length === 0) {
                                    log(`Timeline: plan ${b.title} fully covered by actual on ${label}`);
                                    continue;
                                }
                                if (pieces.length !== 1 || pieces[0][0] !== b.start || pieces[0][1] !== b.end) {
                                    log(`Timeline: plan ${b.title} covered by actual on ${label}, ${pieces.length} piece(s) left`);
                                }
                                let labelIdx = 0;
                                let labelLen = -1;
                                for (let p = 0; p < pieces.length; p++) {
                                    const len = pieces[p][1] - pieces[p][0];
                                    if (len > labelLen) {
                                        labelLen = len;
                                        labelIdx = p;
                                    }
                                }
                                for (let p = 0; p < pieces.length; p++) {
                                    rows.push([
                                        label,
                                        p === labelIdx ? b.displayValue : "",
                                        b.style,
                                        toLocalISOString(pieces[p][0]),
                                        toLocalISOString(pieces[p][1])
                                    ]);
                                    rowHasSpan[label] = true;
                                }
                            } else {
                                rows.push([
                                    label,
                                    b.displayValue,
                                    b.style,
                                    toLocalISOString(b.start),
                                    toLocalISOString(b.end)
                                ]);
                                if (b.end > b.start) rowHasSpan[label] = true;
                            }
                        }
                    }

                    // Google Charts drops a row whose bars all have equal start and end.
                    // One invisible bar across the window keeps an empty row, such as GasHeater.
                    const emptyEndISO = endTs > startTs ? endISORng : toLocalISOString(startTs + 60);
                    for (let i = 0; i < rowLabels.length; i++) {
                        const label = rowLabels[i];
                        if (rowHasSpan[label]) continue;
                        rows.push([label, "", "opacity: 0", startISORng, emptyEndISO]);
                        log(`Timeline: empty row ${label}`);
                    }

                    rowCount = rows.length;
                    output = [columns, ...rows];
                    log(`Timeline: ${rowCount} total rows for ${seriesToQuery.length} series`);

                    // ================================================================
                    // LINE CHART (time-series prices/temperatures)
                    // ================================================================
                } else {
                    // Query calendar for each series
                    const seriesData = {};
                    for (const s of node.series) {
                        if (!s.title) continue;

                        try {
                            // Look back 7 days before startTs to capture step values (like gas prices)
                            // that might be set before the chart window but still valid
                            const lookbackStart = startTs - 7 * 24 * 3600;
                            const params = new URLSearchParams({
                                title: s.title,
                                start: lookbackStart.toString(),
                                end: endTs.toString()
                            });
                            const url = `http://localhost:80/calendar?${params.toString()}`;
                            const resp = await makeRequest(url, 8000);

                            if (Array.isArray(resp)) {
                                const dataMap = new Map();
                                resp.forEach((p) => {
                                    if (p.timestamp !== undefined && p.value !== undefined) {
                                        // Normalize timestamp to seconds (calendar might return ms or s)
                                        const ts = p.timestamp > 1e12 ? Math.floor(p.timestamp / 1000) : Math.floor(p.timestamp);
                                        dataMap.set(ts, Number(p.value));
                                    }
                                });
                                seriesData[s.title] = dataMap;
                                const n = dataMap.size;
                                if (n === 0) {
                                    const sample = resp.length ? JSON.stringify(resp[0]) : "empty";
                                    warn(`Series "${s.title}": 0 points parsed from ${resp.length} API rows (expected timestamp, value). Sample: ${sample}`);
                                } else {
                                    const timestamps = [...dataMap.keys()].sort((a, b) => a - b);
                                    const firstTs = timestamps[0];
                                    const lastTs = timestamps[timestamps.length - 1];
                                    // Show local time for easier debugging
                                    const fmtLocal = (t) => new Date(t * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
                                    const rangeLocal = `${fmtLocal(firstTs)}..${fmtLocal(lastTs)}`;
                                    log(`Loaded ${n} points for ${s.title} (${rangeLocal} local, ts=${firstTs}..${lastTs})`);
                                }
                            } else {
                                warn(`Series "${s.title}": no data from calendar API`);
                                seriesData[s.title] = new Map();
                            }
                        } catch (e) {
                            warn(`Failed to load series ${s.title}: ${e.message}`);
                            seriesData[s.title] = new Map();
                        }
                    }

                    // Build Google Charts JSON format
                    const columns = [
                        { type: "datetime", label: "Aeg" },
                        { type: "string", role: "annotation" }
                    ];

                    for (const s of node.series) {
                        if (!s.title) continue;
                        columns.push({
                            label: s.label || s.title,
                            type: "number"
                        });
                    }

                    const rows = [];
                    const round2 = (v) => (typeof v === "number" && !isNaN(v) ? Math.round(v * 100) / 100 : v);

                    // Generate rows for each timestamp
                    // N intervals need N+1 points (one at start and end of each interval)
                    // 48h at 15min = 192 intervals = 193 points
                    const fmtLocal = (t) => new Date(t * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });

                    // Log first few rows for debugging
                    let debugRowCount = 0;
                    const firstSeriesTitle = node.series.find((x) => x.title)?.title;

                    // For stepped charts, each value needs two rows: start and end of period
                    // Pattern: [T1, values1], [T2, values1], [T2, values2], [T3, values2], ...
                    // This creates horizontal steps with vertical transitions at each timestamp

                    let prevValues = null;

                    for (let ts = startTs; ts <= endTs; ts += stepSeconds) {
                        // Collect values for this timestamp
                        const values = [];
                        for (const s of node.series) {
                            if (!s.title) continue;
                            const dataMap = seriesData[s.title];
                            const isPrice = s.type === "price" || s.type == null;
                            const toEurMwh = (v) => (isPrice && v != null ? v / 100 : v);

                            // Use the current timestamp for data lookup.
                            // Measured series are 0 after now. A null is dropped by the
                            // stepped chart, which then keeps the last kW to the right edge.
                            // Plans still hold their last value.
                            const lookupTs = ts;
                            const isActual = s.title.indexOf("actual_") === 0;

                            let value = null;
                            let usedTs = null;
                            if (isActual && lookupTs > now) {
                                value = 0;
                            } else if (dataMap.has(lookupTs)) {
                                value = dataMap.get(lookupTs);
                                usedTs = lookupTs;
                            } else {
                                let closestTs = -1;
                                for (const [pointTs, pointVal] of dataMap.entries()) {
                                    if (pointTs <= lookupTs && pointTs > closestTs) {
                                        closestTs = pointTs;
                                        value = pointVal;
                                        usedTs = pointTs;
                                    }
                                }
                                if (value == null && dataMap.size > 0) {
                                    const first = [...dataMap.entries()].sort((a, b) => a[0] - b[0])[0];
                                    value = first[1];
                                    usedTs = first[0];
                                }
                            }

                            // Debug first 4 rows for first series only
                            if (debugRowCount < 4 && s.title === firstSeriesTitle) {
                                const displayVal = round2(toEurMwh(value));
                                log(`  Row ${debugRowCount}: ts=${ts} (${fmtLocal(ts)}) → "${toGoogleChartsDate(ts)}" | data_ts=${usedTs} val=${displayVal}`);
                            }

                            values.push(round2(toEurMwh(value)));
                        }

                        const dateStr = toGoogleChartsDate(ts);

                        // For first row, just add it
                        if (prevValues === null) {
                            rows.push([dateStr, null, ...values]);
                        } else {
                            // End previous period with same values at current timestamp
                            rows.push([dateStr, null, ...prevValues]);
                            // Start new period with new values at current timestamp
                            rows.push([dateStr, null, ...values]);
                        }

                        prevValues = values;
                        debugRowCount++;
                    }

                    const numSeriesCols = node.series.filter((s) => s.title).length;

                    // Summary of series with no data (forward-fill handles gaps within data)
                    const emptySeries = node.series.filter((s) => s.title && (!seriesData[s.title] || seriesData[s.title].size === 0));
                    if (emptySeries.length > 0) {
                        warn(`No calendar data for: ${emptySeries.map((s) => s.label || s.title).join(", ")}`);
                    }

                    // Log chart time range for debugging (reuse fmtLocal from earlier)
                    log(`Line chart: ${rows.length} rows, ${numSeriesCols} series, step ${node.stepMinutes}min`);
                    log(`  Time range: ${fmtLocal(startTs)}..${fmtLocal(endTs)} local (ts=${startTs}..${endTs})`);

                    // Current-time marker for webui to render vertical line
                    // Use "<currentTime>" placeholder - webui replaces with actual time
                    if (node.showCurrentTime) {
                        const currentTimeRow = ["<currentTime>", ""].concat(Array(numSeriesCols).fill(null));
                        rows.push(currentTimeRow);
                    }

                    rowCount = rows.length;

                    // Data file contains only data - styling comes from settings file
                    output = [columns, ...rows];
                }

                // Write data to file
                const outputPath = path.resolve(node.outputPath);
                await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");

                log(`Wrote ${rowCount} rows to ${outputPath}`);

                // Generate and write settings file if configured
                if (node.settingsPath) {
                    const settingsPath = path.resolve(node.settingsPath);
                    const settings = generateSettings();
                    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
                    log(`Wrote settings to ${settingsPath}`);
                }
                node.status({ fill: "green", shape: "dot", text: `ok: ${rowCount} rows` });

                // Send output message
                const payloadObj = {
                    path: outputPath,
                    chartType: node.chartType,
                    rows: rowCount,
                    series: node.chartType === "timeline" ? node.timelineSeries.length : node.series.length,
                    timeRange: {
                        start: startTs,
                        end: endTs,
                        startISO: new Date(startTs * 1000).toISOString(),
                        endISO: new Date(endTs * 1000).toISOString()
                    }
                };
                if (node.settingsPath) {
                    payloadObj.settingsPath = path.resolve(node.settingsPath);
                }
                send({
                    topic: "diagram/created",
                    payload: payloadObj
                });

                done();
            } catch (e) {
                err(`Failed to generate diagram: ${e.message}`);
                node.status({ fill: "red", shape: "ring", text: "failed" });
                done(e);
            }
        });

        node.on("close", () => {
            node.status({});
        });
    }

    RED.nodes.registerType("uniflex-diagram-creator", DiagramCreatorNode);
};
