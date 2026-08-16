const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  
  const start = Date.now();
  const res = await db.query("SELECT COUNT(*) FROM logs WHERE message ILIKE '%user%'");
  console.log('Count:', res.rows[0].count, 'Time:', Date.now() - start, 'ms');
  
  const start2 = Date.now();
  const res2 = await db.query("SELECT * FROM logs WHERE message ILIKE '%user%' ORDER BY ts DESC LIMIT 100 OFFSET 50000");
  console.log('Rows:', res2.rows.length, 'Time:', Date.now() - start2, 'ms');
}

test().catch(console.error);
