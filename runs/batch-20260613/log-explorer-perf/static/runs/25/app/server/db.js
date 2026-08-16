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
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= 100000) {
    console.log(`[db] Table already seeded with ${existingCount} rows, skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`[db] Partial seed detected (${existingCount} rows), truncating and reseeding...`);
      await db.exec('TRUNCATE logs RESTART IDENTITY');
    }
    await seedDatabase(db);
  }

  // Create indexes if they don't exist
  console.log('[db] Ensuring indexes...');

  // Core indexes for ordering and severity filtering
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');

  // Try to enable pg_trgm for fast ILIKE substring search
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);
    `);
    console.log('[db] Trigram index created for substring search.');
  } catch (_err) {
    // pg_trgm not available in this PGLite build — ILIKE will use sequential scan
    // but with our ORDER BY ts DESC and LIMIT, performance should still be acceptable
    console.log('[db] pg_trgm not available; ILIKE queries will use sequential filtering.');
  }

  console.log('[db] Indexes ready.');
  return db;
}

module.exports = { initDB };
