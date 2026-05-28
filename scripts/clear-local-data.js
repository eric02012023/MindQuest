require('dotenv').config();
const { getPool, sql } = require('../config/db');

async function clearLocalData() {
  if (process.env.DB_HOST !== 'localhost' && process.env.DB_HOST !== '127.0.0.1') {
    console.error('ERROR: DB_HOST is not localhost. Aborting to protect live data.');
    process.exit(1);
  }
  
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  
  try {
    await transaction.begin();
    console.log('Clearing local analytics, assessments, and modules...');
    
    // Delete child tables first to avoid foreign key constraint errors
    const tablesToClear = [
      'student_assessment_answers',
      'assessment_attempts',
      'assessment_results',
      'assessment_anti_cheat_logs',
      'assessment_questions',
      'assessment_template_questions',
      'module_reads',
      'student_learning_cycles',
      'ai_generation_logs',
      'assessments',
      'assessment_templates',
      'assessment_requests',
      'subject_resources'
    ];

    for (const table of tablesToClear) {
      await transaction.request().query('DELETE FROM ' + table);
      await transaction.request().query(`DBCC CHECKIDENT ('${table}', RESEED, 0)`).catch(() => {}); // Reset auto-increment ID if possible
      console.log('Cleared table: ' + table);
    }
    
    await transaction.commit();
    console.log('Successfully cleared all specified local data!');
    process.exit(0);
  } catch (err) {
    await transaction.rollback();
    console.error('Failed to clear data:', err);
    process.exit(1);
  }
}

clearLocalData();
