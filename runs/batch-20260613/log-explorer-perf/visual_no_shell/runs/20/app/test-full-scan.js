const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  
  console.time('selective substring full scan');
  await db.query("SELECT * FROM logs WHERE message ILIKE '%nonexistent%' ORDER BY ts DESC LIMIT 100 OFFSET 50000");
  console.timeEnd('selective substring full scan');
  
  console.time('count selective substring');
  await db.query("SELECT COUNT(*) FROM logs WHERE message ILIKE '%nonexistent%'");
  console.timeEnd('count selective substring');
}

test().catch(console.error);