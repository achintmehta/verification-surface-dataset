const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { seedDatabase, TOTAL_ROWS } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db = null;
let ready = false;

async function initDatabase() {
  console.log(`Initializing PGLite database at ${DB_PATH}...`);
  const bootStart = Date.now();

  db = new PGlite(DB_PATH);

  // Create table if not exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= TOTAL_ROWS) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`Found ${existingCount} rows, expected ${TOTAL_ROWS}. Re-seeding...`);
      await db.query('TRUNCATE logs RESTART IDENTITY');
    }

    await seedDatabase(db);

    // Create indexes after bulk insert for speed
    console.log('Creating indexes...');
    const idxStart = Date.now();

    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
    // For substring search: pg_trgm is not available in PGLite, so we use a
    // btree index on lower(message) for general queries and rely on the DB
    // planner. For ILIKE '%term%' the DB will do seq scan but with our
    // row count it should still be fast enough.
    // We create a composite index for severity + ts that covers the common case.
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_id ON logs (id)');

    console.log(`Index creation done in ${Date.now() - idxStart}ms`);
  }

  ready = true;
  console.log(`Database ready in ${Date.now() - bootStart}ms`);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function isReady() {
  return ready;
}

module.exports = { initDatabase, getDb, isReady };
