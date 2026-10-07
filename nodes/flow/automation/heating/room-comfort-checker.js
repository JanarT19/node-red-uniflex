const ts = require("../../core/lib/timestamp.js");
/**
 * room-comfort-checker.js
 * Node-RED node: uniflex-room-comfort-checker
 * 
 * Purpose: Aggregate room comfort status from all mpc-room-advanced nodes
 * Output: heating_required (0/1) + room details in msg.details
 * 
 * Reads roomForecasts from flow context (written by mpc-room-advanced nodes)
 * Checks if ANY room will drop below its setpoint without heating
 * 
 * Version: 1.2.0-periodic-check
 */

module.exports = function (RED) {
    function RoomComfortCheckerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        ts.wrapNode(node);

        // Configuration
        const staleThresholdHours = parseFloat(config.staleThresholdHours) || 2.0;
        const staleThresholdMs = staleThresholdHours * 3600 * 1000;
        const outputTopic = config.outputTopic || "MPCGW.8";  // Heating demand status
        
        node.log(`[room-comfort-checker] Initialized | staleThreshold=${staleThresholdHours.toFixed(1)}h | outputTopic=${outputTopic}`);

        // Startup check: give room nodes time to populate forecasts, then run initial check
        setTimeout(() => {
            node.log(`[room-comfort-checker] Running startup check`);
            checkComfort({});  // Trigger check with empty message
        }, 15000);  // 15 second delay

        // Periodic check: run every 5 minutes
        const periodicInterval = setInterval(() => {
            checkComfort({});
        }, 5 * 60 * 1000);  // 5 minutes

        // Main logic function (can be called from input or periodic timer)
        function checkComfort(msg) {
            // Read all room forecasts from flow context
            const roomForecasts = node.context().flow.get("roomForecasts") || {};
            const now = Date.now();
            
            // Filter for healthy, recent room data
            const healthyRooms = [];
            for (const [roomName, roomData] of Object.entries(roomForecasts)) {
                if (!roomData || !roomData.healthy) continue;
                if ((now - roomData.timestamp) > staleThresholdMs) continue;
                if (!roomData.Ti_forecast_noHeat || !Array.isArray(roomData.Ti_forecast_noHeat)) continue;
                
                healthyRooms.push({ name: roomName, ...roomData });
            }
            
            // No room data available
            if (healthyRooms.length === 0) {
                node.warn(`[room-comfort-checker] No healthy room forecasts available`);
                node.status({ fill: "yellow", shape: "ring", text: "no room data" });
                
                // Store safe fallback to context
                node.context().flow.set("heatingRequired", 1);
                
                // Output: assume heating needed (safe fallback)
                const outMsg = { 
                    payload: 1,
                    details: { error: "no room data available" }
                };
                if (outputTopic) {
                    outMsg.topic = outputTopic;
                }
                node.send(outMsg);
                return;
            }
            
            // Check each room for TWO conditions:
            // 1. Current temperature below setpoint (immediate need)
            // 2. Predicted minimum below threshold (future need)
            let heatingRequired = false;
            let coldestRoom = null;
            let coldestMinT = Infinity;
            let urgentRoom = null;  // Room with immediate need
            let maxCurrentError = 0;  // Biggest current error
            
            for (const room of healthyRooms) {
                // Validate forecast data
                if (!room.Ti_forecast_noHeat || !Array.isArray(room.Ti_forecast_noHeat) || room.Ti_forecast_noHeat.length === 0) {
                    continue;
                }
                
                const roomMinT = Math.min(...room.Ti_forecast_noHeat);
                
                // Skip if invalid data (NaN, undefined, etc.)
                if (!isFinite(roomMinT)) {
                    continue;
                }
                
                const roomTmin = room.Tmin || (room.Tset - 0.3);
                const currentError = room.Tset - room.Ti_now;  // Positive if too cold
                
                // Track coldest predicted room
                if (roomMinT < coldestMinT) {
                    coldestMinT = roomMinT;
                    coldestRoom = {
                        name: room.name,
                        Tset: room.Tset,
                        Ti_now: room.Ti_now,
                        currentError: currentError,
                        minT_forecast: roomMinT,
                        Tmin: roomTmin,
                        needsHeating: roomMinT < roomTmin || currentError > 0.3,  // Future OR current
                        delta: Math.max(roomTmin - roomMinT, currentError)  // Worse of the two
                    };
                }
                
                // Track room with biggest current error
                if (currentError > maxCurrentError) {
                    maxCurrentError = currentError;
                    if (currentError > 0.3) {  // Immediate need threshold
                        urgentRoom = {
                            name: room.name,
                            Tset: room.Tset,
                            Ti_now: room.Ti_now,
                            error: currentError
                        };
                    }
                }
                
                // Trigger heating if EITHER condition is true:
                // - Room is currently too cold (Ti < Tset - 0.3°C)
                // - Room will become too cold (predicted minT < Tmin)
                if (currentError > 0.3 || roomMinT < roomTmin) {
                    heatingRequired = true;
                }
            }
            
            // Display most urgent issue in status (prioritize current over predicted)
            let statusText;
            if (urgentRoom) {
                statusText = `⚠ ${urgentRoom.name}: ${urgentRoom.Ti_now.toFixed(1)}°C (NOW ${urgentRoom.error.toFixed(1)}°C cold)`;
            } else if (heatingRequired && coldestRoom) {
                statusText = `⚠ ${coldestRoom.name}: ${coldestMinT.toFixed(1)}°C (will need ${coldestRoom.delta.toFixed(1)}°C)`;
            } else if (coldestRoom) {
                statusText = `✓ ${coldestRoom.name}: ${coldestMinT.toFixed(1)}°C`;
            } else {
                statusText = `✓ ${healthyRooms.length} rooms OK`;
            }
            
            node.status({ 
                fill: heatingRequired ? "yellow" : "green", 
                shape: "dot", 
                text: statusText 
            });
            
            node.log(
                `[room-comfort-checker] Checked ${healthyRooms.length} rooms | ` +
                `heatingRequired=${heatingRequired} | ` +
                (urgentRoom 
                    ? `URGENT: ${urgentRoom.name} Ti=${urgentRoom.Ti_now.toFixed(1)}°C Tset=${urgentRoom.Tset.toFixed(1)}°C error=${urgentRoom.error.toFixed(1)}°C`
                    : (coldestRoom 
                        ? `coldest=${coldestRoom.name} minT=${coldestMinT.toFixed(1)}°C Tmin=${coldestRoom.Tmin.toFixed(1)}°C`
                        : `all rooms data invalid`))
            );
            
            // Store to flow context for mpc-house to read
            node.context().flow.set("heatingRequired", heatingRequired ? 1 : 0);
            
            // Single output with details (also writes to datastream for monitoring)
            const outMsg = { 
                payload: heatingRequired ? 1 : 0,
                details: coldestRoom || null,
                urgent: urgentRoom || null,  // Room with immediate need (if any)
                roomCount: healthyRooms.length
            };
            
            // Add topic (defaults to MPCGW.8 for monitoring)
            if (outputTopic) {
                outMsg.topic = outputTopic;
            }
            
            node.send(outMsg);
        }

        // Input handler: call the check function
        node.on('input', function (msg) {
            checkComfort(msg);
        });

        node.on('close', function () {
            clearInterval(periodicInterval);
            node.log('[room-comfort-checker] Node closed');
        });
    }

    RED.nodes.registerType("uniflex-room-comfort-checker", RoomComfortCheckerNode);
};
