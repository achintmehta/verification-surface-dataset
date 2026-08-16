const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  console.time('deep-offset');
  await db.query(`SELECT * FROM logs WHERE message ILIKE '%message%' ORDER BY ts DESC LIMIT 100 OFFSET 50000`);
  console.timeEnd('deep-offset');
}
test();