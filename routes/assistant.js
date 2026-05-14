/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: routes/assistant.js
 * Purpose: Thin wrapper that creates the admin assistant router using the shared admin factory.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const createAdminRouter = require('./adminFactory');
module.exports = createAdminRouter('admin_assistant');
