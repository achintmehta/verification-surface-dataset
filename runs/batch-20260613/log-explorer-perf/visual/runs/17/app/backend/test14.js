const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  const res = await db.query(`EXPLAIN ANALYZE SELECT * FROM logs WHERE message ILIKE '%message%' ORDER BY ts DESC LIMIT 100 OFFSET 50000`);
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\\n'));
}
test();