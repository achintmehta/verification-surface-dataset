const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function run() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_asc ON logs (severity, ts ASC);`);
  const res = await db.query(`EXPLAIN ANALYZE SELECT id, ts, severity, service, message FROM logs WHERE severity = 'debug' ORDER BY ts ASC LIMIT 100 OFFSET 9900`);
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
}
run();