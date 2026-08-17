require('dotenv').config({ path: process.argv[2] });
const sql = require('mssql');

async function clearUsers() {
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

  console.log(`Connecting to database at ${config.server} using ${process.argv[2]}...`);
  
  let pool;
  try {
    pool = await sql.connect(config);
    console.log('Connected! Disabling foreign keys and clearing all non-admin users...');
    
    // Disable FK checks
    await pool.request().query(`EXEC sp_MSforeachtable "ALTER TABLE ? NOCHECK CONSTRAINT all"`);
    
    // Clear dependent tables first so we don't leave orphaned data
    const tables = [
      'student_assessment_answers',
      'assessment_attempts',
      'tutor_student_answers',
      'tutor_assessment_submissions',
      'tutor_assessments',
      'student_subject_levels',
      'assessment_requests',
      'online_payments',
      'ai_generation_logs',
      'student_learning_cycles',
      'module_reads',
      'assessment_anti_cheat_logs',
      'assessment_results',
      'assessments',
      'subject_enrollment_requests',
      'tutor_schedule_applications',
      'tutor_subjects',
      'tutor_year_levels',
      'otps',
      'email_otps',
      'trusted_devices',
      'student_points',
      'points_history',
      'subject_attendance'
    ];

    for (const table of tables) {
      try {
        await pool.request().query(`DELETE FROM ${table}`);
        console.log(`- Cleared ${table}`);
      } catch (err) {
        console.log(`- Skipped ${table} (${err.message})`);
      }
    }

    // Delete non-admin users
    const userResult = await pool.request().query(`DELETE FROM users WHERE role != 'admin'`);
    console.log(`- Deleted non-admin users. Rows affected: ${userResult.rowsAffected}`);

    // Delete submissions (pending/rejected registrations)
    const subResult = await pool.request().query(`DELETE FROM submissions`);
    console.log(`- Deleted submissions. Rows affected: ${subResult.rowsAffected}`);

    // Re-enable FK checks
    await pool.request().query(`EXEC sp_MSforeachtable "ALTER TABLE ? WITH NOCHECK CHECK CONSTRAINT all"`);
    
    console.log('SUCCESS! Non-admin users and their data have been cleared.');
  } catch (err) {
    console.error('ERROR during data wipe:', err);
    // try to re-enable FK checks if failed
    if (pool) {
        try {
            await pool.request().query(`EXEC sp_MSforeachtable "ALTER TABLE ? WITH NOCHECK CHECK CONSTRAINT all"`);
        } catch (e) {}
    }
  } finally {
    if (pool) await pool.close();
  }
}

clearUsers();
