const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function check() {
  const db = new PGlite(path.join(__dirname, 'pglite-data'));
  await db.waitReady;
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    console.log('Created pg_trgm index.');
  } catch (e) {
    console.log('Error:', e.message);
  }
}
check();