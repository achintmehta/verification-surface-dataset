const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function run() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  const res = await db.query(`EXPLAIN ANALYZE SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900`);
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
}
run();