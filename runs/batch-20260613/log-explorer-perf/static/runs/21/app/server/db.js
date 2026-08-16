const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { seedDatabase } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

async function initDatabase() {
  console.log('[db] Initializing PGLite...');
  const db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
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
      console.log(`[db] Partial data detected (${existingCount} rows), truncating and reseeding...`);
      await db.exec('TRUNCATE logs RESTART IDENTITY');
    }
    await seedDatabase(db);
  }

  // Create indexes (IF NOT EXISTS is implicit with CREATE INDEX IF NOT EXISTS)
  console.log('[db] Ensuring indexes...');

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);
  // For substring search we use pg_trgm if available, otherwise rely on ILIKE with index support
  // PGLite supports btree indexes. For ILIKE queries, we'll create a GIN trigram index if possible.
  // If pg_trgm is not available, we can still use the ts index for ordering.
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);
    `);
    console.log('[db] pg_trgm index created for substring search.');
  } catch (e) {
    console.log('[db] pg_trgm not available, substring search will use sequential filter with index ordering.');
    // Create a simple btree index on message as fallback
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);
    `);
  }

  console.log('[db] Indexes ready.');
  return db;
}

module.exports = { initDatabase };
