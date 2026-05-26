require('dotenv').config();
const { query } = require('../config/db');

async function runCleanup() {
  console.log('Starting cleanup of modules, assessments, analytics, and reports...\n');
  try {
    // 1. Delete analytics, logs, and cycles (which depend on assessments and resources)
    await query(`DELETE FROM student_learning_cycles`);
    console.log('✓ Deleted student_learning_cycles');

    await query(`DELETE FROM ai_generation_logs`);
    console.log('✓ Deleted ai_generation_logs');

    await query(`DELETE FROM module_reads`);
    console.log('✓ Deleted module_reads');

    await query(`DELETE FROM assessment_anti_cheat_logs`);
    console.log('✓ Deleted assessment_anti_cheat_logs');

    // 2. Delete assessment attempts and answers
    await query(`DELETE FROM student_assessment_answers`);
    console.log('✓ Deleted student_assessment_answers');

    await query(`DELETE FROM assessment_attempts`);
    console.log('✓ Deleted assessment_attempts');

    await query(`DELETE FROM assessment_results`);
    console.log('✓ Deleted assessment_results');

    // 3. Delete assessment questions and requests
    await query(`DELETE FROM assessment_questions`);
    console.log('✓ Deleted assessment_questions');

    // Handle assessment_requests if it exists (wrap in try-catch in case it's not in schema)
    try {
      await query(`DELETE FROM assessment_requests`);
      console.log('✓ Deleted assessment_requests');
    } catch (e) {
      // Ignore if table doesn't exist
    }

    // 4. Delete the actual assessments
    await query(`DELETE FROM assessments`);
    console.log('✓ Deleted assessments');

    // 5. Delete modules/resources
    await query(`DELETE FROM subject_resources`);
    console.log('✓ Deleted all modules (subject_resources)');
    
    // 6. Delete templates
    await query(`DELETE FROM assessment_template_questions`);
    console.log('✓ Deleted assessment_template_questions');

    await query(`DELETE FROM assessment_templates`);
    console.log('✓ Deleted assessment_templates');

    console.log('\nCleanup complete! All modules, assessments, analytics, and reports have been cleared.');
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    process.exit(0);
  }
}

runCleanup();
