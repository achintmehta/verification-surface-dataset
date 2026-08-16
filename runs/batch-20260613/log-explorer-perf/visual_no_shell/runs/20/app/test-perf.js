const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  
  console.log('DB ready');
  
  // Check if seeded
  const res = await db.query("SELECT COUNT(*) FROM logs");
  console.log('Total rows:', res.rows[0].count);
  
  // Test offset 99900
  console.time('offset 99900');
  await db.query("SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900");
  console.timeEnd('offset 99900');
  
  // Test severity + offset
  console.time('severity + offset');
  await db.query("SELECT * FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 20000");
  console.timeEnd('severity + offset');
  
  // Test substring + offset
  console.time('substring + offset');
  await db.query("SELECT * FROM logs WHERE message ILIKE '%user%' ORDER BY ts DESC LIMIT 100 OFFSET 50000");
  console.timeEnd('substring + offset');
}

test().catch(console.error);