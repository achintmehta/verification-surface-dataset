const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  await db.query(`SET enable_seqscan = off;`);
  const res = await db.query(`EXPLAIN ANALYZE SELECT COUNT(*) FROM logs WHERE message ILIKE '%99999%'`);
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\\n'));
}
test();