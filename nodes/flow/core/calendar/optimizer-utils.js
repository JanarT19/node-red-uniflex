/**
 * optimizer-utils.js
 *
 * Shared utility library for optimization algorithms.
 * Used by scheduler nodes to find optimal hours/blocks based on calendar data (prices, forecasts).
 *
 * These are generic algorithms - specific scheduler nodes implement their own
 * scoring functions and pass them as callbacks.
 */

/**
 * Find the N cheapest items from an array
 *
 * @param {Array} dataArray - Array of {timestamp, value} objects
 * @param {number} n - Number of items to find
 * @param {Object} [constraints] - Optional constraints
 * @param {number} [constraints.minTimestamp] - Minimum timestamp to consider
 * @param {number} [constraints.maxTimestamp] - Maximum timestamp to consider
 * @param {Function} [constraints.filter] - Custom filter function(item) => boolean
 * @returns {Array} Array of N cheapest items, sorted by timestamp
 */
function findCheapestN(dataArray, n, constraints = {}) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
        return [];
    }

    // Apply constraints
    let filtered = dataArray.filter((item) => {
        if (constraints.minTimestamp && item.timestamp < constraints.minTimestamp) {
            return false;
        }
        if (constraints.maxTimestamp && item.timestamp >= constraints.maxTimestamp) {
            return false;
        }
        if (constraints.filter && !constraints.filter(item)) {
            return false;
        }
        return true;
    });

    // Sort by value (ascending) and take first N
    const sorted = filtered.sort((a, b) => a.value - b.value);
    const cheapest = sorted.slice(0, Math.min(n, sorted.length));

    // Return sorted by timestamp for easier processing
    return cheapest.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Find the cheapest continuous block of specified size
 *
 * @param {Array} dataArray - Array of {timestamp, value} objects (must be sorted by timestamp)
 * @param {number} blockSize - Number of consecutive items in block
 * @param {Object} [constraints] - Optional constraints
 * @param {number} [constraints.minTimestamp] - Minimum timestamp for block start
 * @param {number} [constraints.maxTimestamp] - Maximum timestamp for block end
 * @param {Function} [constraints.filter] - Custom filter function(item) => boolean
 * @returns {Array} Array of items in the cheapest block, or empty if not found
 */
function findCheapestBlock(dataArray, blockSize, constraints = {}) {
    if (!Array.isArray(dataArray) || dataArray.length < blockSize) {
        return [];
    }

    // Apply constraints
    let filtered = dataArray.filter((item) => {
        if (constraints.minTimestamp && item.timestamp < constraints.minTimestamp) {
            return false;
        }
        if (constraints.maxTimestamp && item.timestamp >= constraints.maxTimestamp) {
            return false;
        }
        if (constraints.filter && !constraints.filter(item)) {
            return false;
        }
        return true;
    });

    if (filtered.length < blockSize) {
        return [];
    }

    // Find block with minimum sum
    let minSum = Infinity;
    let minIndex = -1;

    for (let i = 0; i <= filtered.length - blockSize; i++) {
        const block = filtered.slice(i, i + blockSize);
        const sum = block.reduce((acc, item) => acc + item.value, 0);

        if (sum < minSum) {
            minSum = sum;
            minIndex = i;
        }
    }

    if (minIndex >= 0) {
        return filtered.slice(minIndex, minIndex + blockSize);
    }

    return [];
}

/**
 * Find the best item by custom score function
 *
 * The score function should return a HIGHER score for BETTER items.
 *
 * @param {Array} dataArray - Array of {timestamp, value} objects
 * @param {Function} scoreFunction - Function(item) => number (higher = better)
 * @param {Object} [constraints] - Optional constraints
 * @param {number} [constraints.minTimestamp] - Minimum timestamp to consider
 * @param {number} [constraints.maxTimestamp] - Maximum timestamp to consider
 * @param {Function} [constraints.filter] - Custom filter function(item) => boolean
 * @returns {Object|null} Best item with added 'score' property, or null if none found
 */
function findBestByScore(dataArray, scoreFunction, constraints = {}) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
        return null;
    }

    // Apply constraints
    let filtered = dataArray.filter((item) => {
        if (constraints.minTimestamp && item.timestamp < constraints.minTimestamp) {
            return false;
        }
        if (constraints.maxTimestamp && item.timestamp >= constraints.maxTimestamp) {
            return false;
        }
        if (constraints.filter && !constraints.filter(item)) {
            return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        return null;
    }

    // Calculate scores and find best
    let bestItem = null;
    let bestScore = -Infinity;

    for (const item of filtered) {
        const score = scoreFunction(item);
        if (score > bestScore) {
            bestScore = score;
            bestItem = { ...item, score };
        }
    }

    return bestItem;
}

/**
 * Find N best items by custom score function
 *
 * The score function should return a HIGHER score for BETTER items.
 *
 * @param {Array} dataArray - Array of {timestamp, value} objects
 * @param {Function} scoreFunction - Function(item) => number (higher = better)
 * @param {number} n - Number of items to return
 * @param {Object} [constraints] - Optional constraints
 * @param {number} [constraints.minTimestamp] - Minimum timestamp to consider
 * @param {number} [constraints.maxTimestamp] - Maximum timestamp to consider
 * @param {Function} [constraints.filter] - Custom filter function(item) => boolean
 * @returns {Array} Array of N best items with added 'score' property, sorted by score (descending)
 */
function findBestNByScore(dataArray, scoreFunction, n, constraints = {}) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
        return [];
    }

    // Apply constraints
    let filtered = dataArray.filter((item) => {
        if (constraints.minTimestamp && item.timestamp < constraints.minTimestamp) {
            return false;
        }
        if (constraints.maxTimestamp && item.timestamp >= constraints.maxTimestamp) {
            return false;
        }
        if (constraints.filter && !constraints.filter(item)) {
            return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        return [];
    }

    // Calculate scores for all items
    const scored = filtered.map((item) => ({
        ...item,
        score: scoreFunction(item)
    }));

    // Sort by score (descending) and take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.min(n, scored.length));
}

/**
 * Find the best continuous block by custom score function
 *
 * The score function receives the entire block and should return a HIGHER score for BETTER blocks.
 *
 * @param {Array} dataArray - Array of {timestamp, value} objects (must be sorted by timestamp)
 * @param {number} blockSize - Number of consecutive items in block
 * @param {Function} scoreFunction - Function(blockArray) => number (higher = better)
 * @param {Object} [constraints] - Optional constraints
 * @param {number} [constraints.minTimestamp] - Minimum timestamp for block start
 * @param {number} [constraints.maxTimestamp] - Maximum timestamp for block end
 * @param {Function} [constraints.filter] - Custom filter function(item) => boolean
 * @returns {Array} Array of items in the best block, or empty if not found
 */
function findBestBlockByScore(dataArray, blockSize, scoreFunction, constraints = {}) {
    if (!Array.isArray(dataArray) || dataArray.length < blockSize) {
        return [];
    }

    // Apply constraints
    let filtered = dataArray.filter((item) => {
        if (constraints.minTimestamp && item.timestamp < constraints.minTimestamp) {
            return false;
        }
        if (constraints.maxTimestamp && item.timestamp >= constraints.maxTimestamp) {
            return false;
        }
        if (constraints.filter && !constraints.filter(item)) {
            return false;
        }
        return true;
    });

    if (filtered.length < blockSize) {
        return [];
    }

    // Find block with maximum score
    let maxScore = -Infinity;
    let bestBlock = [];

    for (let i = 0; i <= filtered.length - blockSize; i++) {
        const block = filtered.slice(i, i + blockSize);
        const score = scoreFunction(block);

        if (score > maxScore) {
            maxScore = score;
            bestBlock = block;
        }
    }

    return bestBlock;
}

module.exports = {
    findCheapestN,
    findCheapestBlock,
    findBestByScore,
    findBestNByScore,
    findBestBlockByScore
};
