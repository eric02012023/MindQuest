/**
 * File: config/assessmentDefaults.js
 * Purpose: The sizes the assessment system generates, in one place.
 *
 * PRE_ASSESSMENT_ITEM_COUNT is 30 by requirement: one Pre-Assessment per subject,
 * 30 items, drawn from *all* handouts of *all* modules in that subject. The
 * generator already reads every module's handouts (getSubjectHandoutTexts), and
 * spreads the 30 across them by a per-handout quota, so adding a module widens the
 * coverage rather than lengthening the exam.
 *
 * Kept as a constant rather than a literal at each call site so the number cannot
 * drift between the route that opens the exam and the service that builds it.
 */

const PRE_ASSESSMENT_ITEM_COUNT = 30;

// The Post-Assessment reuses the Pre-Assessment's items exactly (spec Section 4b),
// so it is the same size by construction — named here for readability at the
// call sites rather than as a separate knob to tune.
const POST_ASSESSMENT_ITEM_COUNT = PRE_ASSESSMENT_ITEM_COUNT;

// A tutor picks their own item count per module assessment; these bound the form.
const TUTOR_ASSESSMENT_MIN_ITEMS = 1;
const TUTOR_ASSESSMENT_MAX_ITEMS = 50;

module.exports = {
  PRE_ASSESSMENT_ITEM_COUNT,
  POST_ASSESSMENT_ITEM_COUNT,
  TUTOR_ASSESSMENT_MIN_ITEMS,
  TUTOR_ASSESSMENT_MAX_ITEMS
};
