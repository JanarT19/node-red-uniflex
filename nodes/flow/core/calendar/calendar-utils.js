/**
 * calendar-utils.js
 *
 * Shared utility library for accessing the Python calendar API via HTTP.
 * Used by scheduler nodes (sauna-scheduler, mpc-scheduler, etc.) to read/write calendar data.
 *
 * All functions return Promises and include retry logic for resilience.
 */

const http = require("http");
const https = require("https");

/**
 * Make HTTP request to calendar API with retry logic
 * @private
 */
function makeRequest(options, postData = null, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        let attempt = 0;

        function tryRequest() {
            attempt++;
            const protocol = options.protocol === "https:" ? https : http;

            const req = protocol.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => {
                    data += chunk;
                });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(data);
                            resolve(parsed);
                        } catch (err) {
                            reject(new Error(`Invalid JSON response: ${err.message}`));
                        }
                    } else {
                        const error = new Error(`HTTP ${res.statusCode}: ${data}`);
                        if (attempt < maxRetries && res.statusCode >= 500) {
                            // Retry on server errors
                            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                            setTimeout(tryRequest, delay);
                        } else {
                            reject(error);
                        }
                    }
                });
            });

            req.on("error", (err) => {
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    setTimeout(tryRequest, delay);
                } else {
                    reject(err);
                }
            });

            if (postData) {
                req.write(postData);
            }
            req.end();
        }

        tryRequest();
    });
}

/**
 * Get controller config from config node
 * @private
 */
function getControllerConfig(controllerNode) {
    if (!controllerNode) {
        throw new Error("Controller config node not configured");
    }

    const host = controllerNode.host || "localhost";
    const port = controllerNode.port || 9924;
    const useHttps = controllerNode.https || false;

    return {
        host,
        port,
        protocol: useHttps ? "https:" : "http:"
    };
}

/**
 * Read calendar series data for a time range
 *
 * @param {Object} controllerNode - Controller config node
 * @param {string} title - Series title (e.g., "heat_price")
 * @param {number} startTimestamp - Unix timestamp (seconds)
 * @param {number} endTimestamp - Unix timestamp (seconds)
 * @returns {Promise<Array>} Array of {timestamp, value} objects
 */
async function readSeries(controllerNode, title, startTimestamp, endTimestamp) {
    const config = getControllerConfig(controllerNode);

    const queryParams = new URLSearchParams({
        operation: "read",
        title: title,
        start: startTimestamp.toString(),
        end: endTimestamp.toString()
    });

    const options = {
        hostname: config.host,
        port: config.port,
        path: `/calendar?${queryParams.toString()}`,
        method: "GET",
        protocol: config.protocol,
        headers: {
            Accept: "application/json"
        }
    };

    const response = await makeRequest(options);

    if (response.success && Array.isArray(response.data)) {
        return response.data; // [{timestamp, value}, ...]
    } else {
        throw new Error(`Calendar read failed: ${response.error || "Unknown error"}`);
    }
}

/**
 * Check if an event is currently active
 *
 * @param {Object} controllerNode - Controller config node
 * @param {string} title - Event title
 * @returns {Promise<Object|false>} Event data {timestamp, value, duration} or false if not active
 */
async function checkEvent(controllerNode, title) {
    const config = getControllerConfig(controllerNode);

    const queryParams = new URLSearchParams({
        operation: "check",
        title: title
    });

    const options = {
        hostname: config.host,
        port: config.port,
        path: `/calendar?${queryParams.toString()}`,
        method: "GET",
        protocol: config.protocol,
        headers: {
            Accept: "application/json"
        }
    };

    const response = await makeRequest(options);

    if (response.success) {
        return response.value !== undefined
            ? {
                  timestamp: response.timestamp,
                  value: response.value,
                  duration: response.duration
              }
            : false;
    } else {
        throw new Error(`Calendar check failed: ${response.error || "Unknown error"}`);
    }
}

/**
 * Create a calendar event
 *
 * @param {Object} controllerNode - Controller config node
 * @param {string} title - Event title
 * @param {number} timestamp - Unix timestamp (seconds)
 * @param {number} value - Event value
 * @param {number} [duration] - Event duration in seconds (optional)
 * @returns {Promise<boolean>} True if successful
 */
async function createEvent(controllerNode, title, timestamp, value, duration = null) {
    const config = getControllerConfig(controllerNode);

    const payload = {
        operation: "create",
        title: title,
        timestamp: timestamp,
        value: value
    };

    if (duration !== null) {
        payload.duration = duration;
    }

    const postData = JSON.stringify(payload);

    const options = {
        hostname: config.host,
        port: config.port,
        path: "/calendar",
        method: "POST",
        protocol: config.protocol,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            Accept: "application/json"
        }
    };

    const response = await makeRequest(options, postData);

    if (response.success) {
        return true;
    } else {
        throw new Error(`Calendar create failed: ${response.error || "Unknown error"}`);
    }
}

/**
 * Update an existing calendar event
 *
 * @param {Object} controllerNode - Controller config node
 * @param {string} title - Event title
 * @param {number} timestamp - Unix timestamp (seconds)
 * @param {number} value - New event value
 * @param {number} [duration] - New event duration in seconds (optional)
 * @returns {Promise<boolean>} True if successful
 */
async function updateEvent(controllerNode, title, timestamp, value, duration = null) {
    const config = getControllerConfig(controllerNode);

    const payload = {
        operation: "update",
        title: title,
        timestamp: timestamp,
        value: value
    };

    if (duration !== null) {
        payload.duration = duration;
    }

    const postData = JSON.stringify(payload);

    const options = {
        hostname: config.host,
        port: config.port,
        path: "/calendar",
        method: "POST",
        protocol: config.protocol,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            Accept: "application/json"
        }
    };

    const response = await makeRequest(options, postData);

    if (response.success) {
        return true;
    } else {
        throw new Error(`Calendar update failed: ${response.error || "Unknown error"}`);
    }
}

/**
 * Delete calendar events matching criteria
 *
 * @param {Object} controllerNode - Controller config node
 * @param {string} title - Event title
 * @param {number} [startTimestamp] - Unix timestamp (seconds) - delete events >= this time
 * @param {number} [endTimestamp] - Unix timestamp (seconds) - delete events < this time
 * @returns {Promise<number>} Number of events deleted
 */
async function deleteEvents(controllerNode, title, startTimestamp = null, endTimestamp = null) {
    const config = getControllerConfig(controllerNode);

    const payload = {
        operation: "delete",
        title: title
    };

    if (startTimestamp !== null) {
        payload.start = startTimestamp;
    }
    if (endTimestamp !== null) {
        payload.end = endTimestamp;
    }

    const postData = JSON.stringify(payload);

    const options = {
        hostname: config.host,
        port: config.port,
        path: "/calendar",
        method: "POST",
        protocol: config.protocol,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            Accept: "application/json"
        }
    };

    const response = await makeRequest(options, postData);

    if (response.success) {
        return response.deleted || 0;
    } else {
        throw new Error(`Calendar delete failed: ${response.error || "Unknown error"}`);
    }
}

module.exports = {
    readSeries,
    checkEvent,
    createEvent,
    updateEvent,
    deleteEvents
};
