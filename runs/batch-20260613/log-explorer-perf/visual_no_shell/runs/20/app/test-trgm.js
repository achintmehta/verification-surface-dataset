const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
async function test() {
  const db = new PGlite();
  await db.waitReady;
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    fs.writeFileSync('test-result.txt', 'pg_trgm works');
  } catch (e) {
    fs.writeFileSync('test-result.txt', 'pg_trgm failed: ' + e.message);
  }
}
test();