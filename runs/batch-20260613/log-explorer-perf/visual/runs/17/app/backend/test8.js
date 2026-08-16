const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  console.time('strpos');
  await db.query(`SELECT *, COUNT(*) OVER() as total_count FROM logs WHERE strpos(lower(message), '99999') > 0 ORDER BY ts DESC LIMIT 100 OFFSET 0`);
  console.timeEnd('strpos');
}
test();