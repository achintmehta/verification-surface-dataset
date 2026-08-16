const { PGlite } = require('@electric-sql/pglite');
async function test() {
  const db = new PGlite('./test-db');
  await db.waitReady;
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    console.log('pg_trgm supported');
  } catch (e) {
    console.log('pg_trgm not supported', e);
  }
}
test();