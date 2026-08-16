const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { seedDatabase } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

async function initDB() {
  console.log('[db] Initializing PGLite...');
  const db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= 100000) {
    console.log(`[db] Table already has ${existingCount} rows, skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`[db] Partial seed detected (${existingCount} rows), truncating and reseeding...`);
      await db.exec('TRUNCATE logs RESTART IDENTITY');
    }
    await seedDatabase(db);
  }

  // Create indexes (IF NOT EXISTS)
  console.log('[db] Ensuring indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // Enable pg_trgm for substring search if available, otherwise we'll use ILIKE with index
  // PGLite may not support pg_trgm, so we rely on the severity+ts index and sequential scan for substring
  // For substring search optimization, we'll create a GIN index on message if possible
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops)');
    console.log('[db] pg_trgm extension and GIN index created successfully.');
  } catch (e) {
    console.log('[db] pg_trgm not available, substring search will use sequential scan with index filter.');
    // Create a btree index on lower(message) as a fallback - won't help ILIKE but keeps things tidy
  }

  console.log('[db] Initialization complete.');
  return db;
}

module.exports = { initDB };
