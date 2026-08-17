require('dotenv').config({ path: process.argv[2] });
const sql = require('mssql');

async function checkUsers() {
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

  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query('SELECT role, COUNT(*) as count FROM users GROUP BY role');
    console.log(`\nUser counts for ${process.argv[2]}:`);
    console.table(result.recordset);
    
    const submissionsResult = await pool.request().query('SELECT COUNT(*) as count FROM submissions');
    console.log(`Pending submissions count: ${submissionsResult.recordset[0].count}`);
    
    await pool.close();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkUsers();
