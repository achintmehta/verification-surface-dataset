const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function check() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  const res = await db.query(`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = 'logs';
  `);
  console.log(res.rows);
}
check();