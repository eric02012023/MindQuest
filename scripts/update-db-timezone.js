require('dotenv').config();
const { getPool } = require('../config/db');

async function updateDbTimezoneConstraints() {
  console.log('Starting DB timezone default constraints update...');
  try {
    // 1. Get all default constraints containing SYSDATETIME or GETDATE
    const getConstraintsSql = `
      SELECT 
          t.name AS table_name,
          c.name AS column_name,
          d.name AS constraint_name
      FROM sys.tables t
      JOIN sys.default_constraints d ON d.parent_object_id = t.object_id
      JOIN sys.columns c ON c.object_id = t.object_id AND c.column_id = d.parent_column_id
      WHERE d.definition LIKE '%SYSDATETIME%' OR d.definition LIKE '%GETDATE%';
    `;
    
    const pool = await getPool();
    const result = await pool.request().query(getConstraintsSql);
    const constraints = result.recordset;

    console.log(`Found ${constraints.length} constraints to update.`);

    // 2. Loop through and replace them
    for (const c of constraints) {
      console.log(`Updating constraint ${c.constraint_name} on table ${c.table_name}(${c.column_name})...`);
      
      const dropSql = `ALTER TABLE dbo.[${c.table_name}] DROP CONSTRAINT [${c.constraint_name}];`;
      await pool.request().query(dropSql);
      
      const newConstraintName = `df_${c.table_name}_${c.column_name}_pht`;
      const addSql = `ALTER TABLE dbo.[${c.table_name}] ADD CONSTRAINT [${newConstraintName}] DEFAULT DATEADD(hour, 8, GETUTCDATE()) FOR [${c.column_name}];`;
      await pool.request().query(addSql);
    }

    console.log('Successfully updated all DB constraints to use PHT (DATEADD(hour, 8, GETUTCDATE())).');
  } catch (error) {
    console.error('Error during update:', error);
  } finally {
    process.exit(0);
  }
}

updateDbTimezoneConstraints();
