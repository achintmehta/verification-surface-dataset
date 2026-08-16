const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { seedLogs } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let dbInstance = null;

async function initDB() {
  if (dbInstance) return dbInstance;

  console.log('[db] Initializing PGLite at', DB_PATH);
  const db = new PGlite(DB_PATH);
  dbInstance = db;

  // Create table if not exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Check if data exists
  const result = await db.query('SELECT COUNT(*)::int AS count FROM logs');
  const count = result.rows[0].count;

  if (count === 0) {
    console.log('[db] Empty table detected, seeding 100,000 rows...');
    await seedLogs(db);

    // Create indexes after bulk insert for faster seeding
    console.log('[db] Creating indexes...');
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)');
    // pg_trgm not available in PGLite, use btree index on lower(message) for partial help
    // For ILIKE queries, we rely on sequential scan being fast enough with the small dataset
    // or create a GIN index if available
    try {
      await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops)');
      console.log('[db] pg_trgm index created');
    } catch (e) {
      console.log('[db] pg_trgm not available, using alternative strategy');
      // Create a basic index for message lookups - won't help ILIKE but doesn't hurt
    }

    console.log('[db] Indexes created');
    console.log('[db] Running ANALYZE...');
    await db.query('ANALYZE logs');
  } else {
    console.log(`[db] Table already has ${count} rows, skipping seed`);
  }

  return db;
}

module.exports = { initDB };
