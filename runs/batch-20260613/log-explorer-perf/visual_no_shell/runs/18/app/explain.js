import { PGlite } from '@electric-sql/pglite';

async function test() {
  const db = new PGlite('./pglite-data');
  await db.waitReady;
  
  const res = await db.query('EXPLAIN ANALYZE SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900');
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
}

test().catch(console.error);
