require('dotenv').config();
const { query, withTransaction } = require('../config/db');

async function deleteUserByName(firstName, lastName) {
  try {
    const users = await query('SELECT id, first_name, last_name, role FROM users WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?)', [firstName, lastName]);
    
    if (users.length === 0) {
      console.log(`User "${firstName} ${lastName}" not found.`);
      return;
    }

    for (const user of users) {
      console.log(`Deleting user: ${user.first_name} ${user.last_name} (ID: ${user.id}, Role: ${user.role})...`);
      
      await withTransaction(async (connection) => {
        const userId = user.id;

        // Delete dependencies (Add more if needed based on schema)
        // 1. Attendance
        await connection.query('DELETE FROM attendance WHERE student_id = ? OR tutor_id = ?', [userId, userId]);
        
        // 2. Billing & Payments
        await connection.query('DELETE FROM payment_history WHERE student_id = ?', [userId]);
        await connection.query('DELETE FROM soa_posts WHERE student_id = ?', [userId]);
        await connection.query('DELETE FROM online_payments WHERE student_id = ?', [userId]);
        await connection.query('DELETE FROM billing WHERE student_id = ?', [userId]);
        
        // 3. Assignments
        await connection.query('DELETE FROM user_subject_assignments WHERE student_id = ? OR tutor_id = ? OR accepted_by = ?', [userId, userId, userId]);
        
        // 4. Assessments
        await connection.query('DELETE FROM assessment_anti_cheat_logs WHERE student_id = ?', [userId]);
        await connection.query('DELETE FROM student_assessment_answers WHERE attempt_id IN (SELECT id FROM assessment_attempts WHERE student_id = ?)', [userId]);
        await connection.query('DELETE FROM assessment_attempts WHERE student_id = ?', [userId]);
        await connection.query('DELETE FROM assessment_results WHERE student_id = ?', [userId]);
        await connection.query('DELETE FROM student_learning_cycles WHERE student_id = ?', [userId]);
        await connection.query('DELETE FROM assessments WHERE assigned_student_id = ? OR created_by = ? OR assigned_by_tutor_id = ?', [userId, userId, userId]);
        
        // 5. Messages & Notifications
        await connection.query('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [userId, userId]);
        
        // 6. Security & Meta
        await connection.query('DELETE FROM otps WHERE user_id = ?', [userId]);
        await connection.query('DELETE FROM trusted_devices WHERE user_id = ?', [userId]);
        await connection.query('DELETE FROM tutor_year_levels WHERE tutor_id = ?', [userId]);
        await connection.query('DELETE FROM subject_enrollment_requests WHERE student_id = ? OR decided_by = ?', [userId, userId]);
        await connection.query('DELETE FROM tutor_schedule_applications WHERE student_id = ? OR tutor_id = ? OR decided_by = ?', [userId, userId, userId]);
        await connection.query('DELETE FROM ai_generation_logs WHERE student_id = ?', [userId]);
        
        // 7. Finally, the user
        await connection.query('DELETE FROM users WHERE id = ?', [userId]);
      });
      
      console.log(`Successfully deleted ${user.first_name} ${user.last_name}.`);
    }
  } catch (error) {
    console.error('Error deleting user:', error);
  } finally {
    process.exit();
  }
}

// Get names from command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node scripts/delete-user-by-name.js "First Name" "Last Name"');
  process.exit();
}

deleteUserByName(args[0], args[1]);
