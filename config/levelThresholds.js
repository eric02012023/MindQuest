/**
 * Configuration for Assessment Level Assignment
 */
const levelThresholds = {
    beginner: { min: 0, max: 59 },
    intermediate: { min: 60, max: 79 },
    advanced: { min: 80, max: 100 }
};

/**
 * Determines the level based on a percentage score.
 * @param {number} percentage - The score percentage (0-100)
 * @returns {string} 'Beginner', 'Intermediate', or 'Advanced'
 */
function determineLevel(percentage) {
    const p = Number(percentage);
    
    if (p >= levelThresholds.advanced.min) {
        return 'Advanced';
    } else if (p >= levelThresholds.intermediate.min) {
        return 'Intermediate';
    } else {
        return 'Beginner';
    }
}

module.exports = {
    levelThresholds,
    determineLevel
};
