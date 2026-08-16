const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function run() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  const res = await db.query(`EXPLAIN ANALYZE SELECT id, ts, severity, service, message FROM logs WHERE severity = 'debug' ORDER BY severity DESC, ts ASC LIMIT 100 OFFSET 9900`);
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
}
run();