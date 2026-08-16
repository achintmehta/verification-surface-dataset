const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function run() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  
  await db.query('BEGIN');
  await db.query('SET LOCAL enable_bitmapscan = off');
  await db.query('SET LOCAL enable_seqscan = off');
  const res = await db.query(`EXPLAIN ANALYZE SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%user%' ORDER BY ts DESC LIMIT 100 OFFSET 9900`);
  await db.query('COMMIT');
  
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
}
run();