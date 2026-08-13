const sql = require('mssql');

async function clearData() {
  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_HOST,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '1433'),
    options: {
      encrypt: true,
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'
    }
  };

  console.log(`Connecting to database at ${config.server}...`);
  
  let pool;
  try {
    pool = await sql.connect(config);
    console.log('Connected! Deleting data in correct order to avoid foreign key constraints...');
    
    const tablesToDelete = [
      'student_assessment_answers',
      'assessment_anti_cheat_logs',
      'assessment_results',
      'assessment_attempts',
      'assessment_questions',
      'student_learning_cycles',
      'assessments',
      'module_reads',
      'ai_generation_logs',
      'subject_resources'
    ];

    for (const table of tablesToDelete) {
      console.log(`Deleting all records from ${table}...`);
      await pool.request().query(`DELETE FROM ${table}`);
      console.log(`- Cleared ${table}`);
    }

    console.log('SUCCESS! All requested data has been wiped out.');
  } catch (err) {
    console.error('ERROR during data wipe:', err);
  } finally {
    if (pool) await pool.close();
  }
}

clearData();
