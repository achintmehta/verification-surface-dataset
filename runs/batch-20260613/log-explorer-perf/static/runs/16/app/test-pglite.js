const { PGlite } = require('@electric-sql/pglite');

async function test() {
  const db = new PGlite();
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    console.log('pg_trgm is available');
  } catch (e) {
    console.error('pg_trgm not available:', e);
  }
}
test();