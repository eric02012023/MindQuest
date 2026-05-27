const { query } = require('../config/db');
async function run() {
  try {
    await query("ALTER TABLE assessment_questions ADD source_module_title NVARCHAR(200) NULL;");
    console.log('Column added successfully');
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    process.exit();
  }
}
run();
