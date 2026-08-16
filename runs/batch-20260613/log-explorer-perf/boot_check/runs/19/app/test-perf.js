const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function test() {
  const db = new PGlite(path.join(__dirname, 'backend/pglite-data'));
  await db.waitReady;

  async function measure(name, query, params) {
    const start = Date.now();
    await db.query(query, params);
    const end = Date.now();
    console.log(`${name}: ${end - start}ms`);
  }

  await measure('Offset 0', 'SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 0');
  await measure('Offset 50000', 'SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000');
  await measure('Offset 99900', 'SELECT * FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900');

  await measure('Severity + Offset 50000', "SELECT * FROM logs WHERE severity = 'info' ORDER BY ts DESC LIMIT 100 OFFSET 50000");

  await measure('Substring + Offset 0', "SELECT * FROM logs WHERE message ILIKE '%timeout%' ORDER BY ts DESC LIMIT 100 OFFSET 0");
  await measure('Substring + Offset 50000', "SELECT * FROM logs WHERE message ILIKE '%timeout%' ORDER BY ts DESC LIMIT 100 OFFSET 50000");
}

test().catch(console.error);
