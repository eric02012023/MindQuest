require('dotenv').config();
const { getPool } = require('../config/db');

async function migrateAssessmentSchema() {
  console.log('Starting assessment schema migration...\n');
  const pool = await getPool();

  const migrations = [
    // 1. assessments.assessment_origin
    {
      check: `SELECT COL_LENGTH('dbo.assessments', 'assessment_origin') AS col`,
      run: `ALTER TABLE dbo.assessments ADD assessment_origin NVARCHAR(30) NOT NULL CONSTRAINT df_assessments_origin DEFAULT 'admin_created'`,
      label: 'assessments.assessment_origin'
    },
    // 2. assessments.source_module_title
    {
      check: `SELECT COL_LENGTH('dbo.assessments', 'source_module_title') AS col`,
      run: `ALTER TABLE dbo.assessments ADD source_module_title NVARCHAR(200) NULL`,
      label: 'assessments.source_module_title'
    },
    // 3. assessment_questions.essay_rubric_keywords
    {
      check: `SELECT COL_LENGTH('dbo.assessment_questions', 'essay_rubric_keywords') AS col`,
      run: `ALTER TABLE dbo.assessment_questions ADD essay_rubric_keywords NVARCHAR(MAX) NULL`,
      label: 'assessment_questions.essay_rubric_keywords'
    },
    // 4. assessment_results.per_module_scores_json
    {
      check: `SELECT COL_LENGTH('dbo.assessment_results', 'per_module_scores_json') AS col`,
      run: `ALTER TABLE dbo.assessment_results ADD per_module_scores_json NVARCHAR(MAX) NULL`,
      label: 'assessment_results.per_module_scores_json'
    },
    // 5. assessment_template_questions.essay_rubric_keywords
    {
      check: `SELECT COL_LENGTH('dbo.assessment_template_questions', 'essay_rubric_keywords') AS col`,
      run: `ALTER TABLE dbo.assessment_template_questions ADD essay_rubric_keywords NVARCHAR(MAX) NULL`,
      label: 'assessment_template_questions.essay_rubric_keywords'
    },
    // 6. Update existing AI-generated assessments to have the correct origin
    {
      check: null, // always run
      run: `UPDATE dbo.assessments SET assessment_origin = 'ai_generated' WHERE assessment_origin = 'admin_created' AND source_template_id IS NULL AND EXISTS (SELECT 1 FROM dbo.subject_resources sr WHERE sr.id = dbo.assessments.source_resource_id AND sr.module_origin = 'ai_generated')`,
      label: 'Update AI-generated assessments origin'
    }
  ];

  for (const m of migrations) {
    try {
      if (m.check) {
        const result = await pool.request().query(m.check);
        if (result.recordset[0].col !== null) {
          console.log(`✓ ${m.label} — already exists, skipping.`);
          continue;
        }
      }
      await pool.request().query(m.run);
      console.log(`✓ ${m.label} — applied.`);
    } catch (err) {
      console.error(`✗ ${m.label} — error:`, err.message);
    }
  }

  console.log('\nMigration complete!');
  process.exit(0);
}

migrateAssessmentSchema();
