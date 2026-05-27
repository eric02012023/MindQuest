const { query } = require('./config/db');

async function clearTable(tableName) {
  try {
    await query(`DELETE FROM ${tableName}`);
    console.log(`Cleared ${tableName}`);
  } catch (e) {
    console.log(`Skipped ${tableName}: ${e.message}`);
  }
}

async function run() {
  try {
    console.log('Clearing database tables...');
    
    // Clear Analytics & Reports
    await clearTable("student_learning_cycles");
    await clearTable("learning_cycles");
    await clearTable("student_module_reads");
    await clearTable("ai_generation_logs");
    await clearTable("student_points");
    await clearTable("points_history");
    await clearTable("subject_attendance");
    
    // Clear Assessments
    await clearTable("assessment_questions");
    await clearTable("assessment_results");
    await clearTable("assessment_requests");
    await clearTable("assessments");
    await clearTable("assessment_templates");
    
    // Clear Modules
    await clearTable("subject_resources");

    console.log('Successfully cleared modules, assessments, and analytics.');
  } catch (err) {
    console.error('Error during cleanup:', err);
  }
  process.exit(0);
}

run();
