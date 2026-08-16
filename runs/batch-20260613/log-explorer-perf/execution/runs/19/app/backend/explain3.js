const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function run() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  const res = await db.query(`EXPLAIN ANALYZE SELECT COUNT(*) as count FROM logs`);
  console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
}
run();