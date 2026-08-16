const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, '.pglite'));
  await db.waitReady;

  console.time('count');
  await db.query("SELECT COUNT(*) FROM logs WHERE message ILIKE '%error%'");
  console.timeEnd('count');

  console.time('query');
  await db.query("SELECT * FROM logs WHERE message ILIKE '%error%' ORDER BY ts DESC LIMIT 100 OFFSET 50000");
  console.timeEnd('query');
}

test();
