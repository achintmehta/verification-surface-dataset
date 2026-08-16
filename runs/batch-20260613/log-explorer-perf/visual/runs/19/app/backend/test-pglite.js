const { PGlite } = require('@electric-sql/pglite');

async function test() {
  const db = new PGlite();
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    console.log('pg_trgm supported');
  } catch (e) {
    console.error('pg_trgm not supported:', e);
  }
}
test();