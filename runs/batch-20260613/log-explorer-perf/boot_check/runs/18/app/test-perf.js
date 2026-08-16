const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const dbPath = path.join(__dirname, 'pglite-data');
  const db = new PGlite(dbPath);
  await db.waitReady;

  console.time('offset 0');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 0');
  console.timeEnd('offset 0');

  console.time('offset 50000');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000');
  console.timeEnd('offset 50000');

  console.time('offset 99900');
  await db.query('SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900');
  console.timeEnd('offset 99900');

  console.time('severity offset 50000');
  await db.query("SELECT * FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 50000");
  console.timeEnd('severity offset 50000');

  console.time('q offset 50000');
  await db.query("SELECT * FROM logs WHERE message ILIKE '%user%' ORDER BY ts DESC LIMIT 100 OFFSET 50000");
  console.timeEnd('q offset 50000');
}

test().catch(console.error);
