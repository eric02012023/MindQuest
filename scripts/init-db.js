/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: scripts/init-db.js
 * Purpose: Source file for scripts/init-db.js. This annotated copy adds reviewer-friendly comments to explain the purpose of the code.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

require('dotenv').config();
const { bootstrapDatabase } = require('../lib/bootstrap');

bootstrapDatabase()
  .then(({ dbName }) => {
    console.log('Database initialized successfully.');
    console.log(`Database: ${dbName}`);
    console.log('Default admin email: admin@mindquest.local');
    console.log('Default admin password: Admin@12345');
  })
  .catch((error) => {
    console.error('Failed to initialize database.');
    console.error(error);
    process.exit(1);
  });
