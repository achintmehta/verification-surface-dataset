const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  console.time('non-selective');
  await db.query(`SELECT *, COUNT(*) OVER() as total_count FROM logs WHERE message ILIKE '%message%' ORDER BY ts DESC LIMIT 100 OFFSET 0`);
  console.timeEnd('non-selective');
}
test();