require('dotenv').config();
const { query } = require('../config/db');

async function main() {
  try {
    const cols = await query(
      "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'assessment_questions' AND COLUMN_NAME = 'correct_answer'"
    );
    console.log('assessment_questions.correct_answer:', JSON.stringify(cols[0]));

    const checks = await query(
      "SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID('dbo.assessment_questions')"
    );
    console.log('CHECK constraints:', JSON.stringify(checks));

    const cols2 = await query(
      "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'assessment_template_questions' AND COLUMN_NAME = 'correct_answer'"
    );
    console.log('assessment_template_questions.correct_answer:', JSON.stringify(cols2[0]));
  } catch (e) {
    console.error(e);
  }
  process.exit();
}
main();
