/**
 * Configuration for Assessment Level Assignment
 *
 * Single source of truth for turning a percentage into a classification.
 *
 * Bands come from the spec (Section 5):
 *   0-50%   -> Beginner
 *   51-80%  -> Intermediate
 *   81-100% -> Advance
 *
 * Three different schemes used to coexist and none matched the spec:
 *   - this file used 0-59 / 60-79 / 80-100 and returned 'Advanced'
 *   - scoreToLevel() in lib/data.js used 0-40 / 41-70 / 71-100 and returned 'Advance'
 * A student scoring 55% was therefore Beginner on one code path and Intermediate
 * on the other.
 *
 * The spelling is 'Advance', not 'Advanced'. The DB is the reason this matters:
 * assessment_results.level and assessment_attempts.level have CHECK constraints
 * that only accept 'Advance', so returning 'Advanced' made those inserts fail.
 * The Phase 2 migration aligned student_subject_levels and modules to 'Advance'
 * too, so one value is now valid everywhere.
 */

const LEVEL_BEGINNER = 'Beginner';
const LEVEL_INTERMEDIATE = 'Intermediate';
const LEVEL_ADVANCE = 'Advance';

const levelThresholds = {
    beginner: { min: 0, max: 50 },
    intermediate: { min: 51, max: 80 },
    advance: { min: 81, max: 100 }
};

/**
 * Determines the level based on a percentage score.
 *
 * Boundaries are inclusive of the band maximum, so a fractional score such as
 * 50.4 stays Beginner and 50.6 becomes Intermediate.
 *
 * @param {number} percentage - The score percentage (0-100)
 * @returns {'Beginner'|'Intermediate'|'Advance'}
 */
function determineLevel(percentage) {
    const p = Number(percentage);
    if (!Number.isFinite(p)) return LEVEL_BEGINNER;
    if (p <= levelThresholds.beginner.max) return LEVEL_BEGINNER;
    if (p <= levelThresholds.intermediate.max) return LEVEL_INTERMEDIATE;
    return LEVEL_ADVANCE;
}

module.exports = {
    levelThresholds,
    determineLevel,
    LEVEL_BEGINNER,
    LEVEL_INTERMEDIATE,
    LEVEL_ADVANCE
};
