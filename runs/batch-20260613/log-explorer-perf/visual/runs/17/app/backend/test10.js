const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  console.time('separate');
  await db.query(`SELECT COUNT(*) FROM logs WHERE message ILIKE '%99999%'`);
  await db.query(`SELECT * FROM logs WHERE message ILIKE '%99999%' ORDER BY ts DESC LIMIT 100 OFFSET 0`);
  console.timeEnd('separate');
}
test();