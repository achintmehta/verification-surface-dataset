const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  console.time('count');
  await db.query(`SELECT COUNT(*) FROM logs WHERE message ILIKE '%99999%'`);
  console.timeEnd('count');
}
test();