const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { seedDatabase } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

async function initDB() {
  const db = new PGlite(DB_PATH);

  // Check if already seeded
  try {
    const result = await db.query(`SELECT COUNT(*)::int AS cnt FROM logs`);
    const count = result.rows[0].cnt;
    if (count >= 100000) {
      console.log(`Database already seeded with ${count} rows. Skipping seed.`);
      return db;
    }
  } catch (e) {
    // Table doesn't exist yet, proceed with schema creation
  }

  // Create schema
  await db.query(`DROP TABLE IF EXISTS logs`);
  await db.query(`
    CREATE TABLE logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  // Seed data
  await seedDatabase(db);

  // Create indexes after bulk insert for speed
  console.log('Creating indexes...');
  console.time('indexes');
  await db.query(`CREATE INDEX idx_logs_ts ON logs (ts DESC)`);
  await db.query(`CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC)`);

  // Try to enable pg_trgm for faster ILIKE substring searches
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.query(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops)`);
    console.log('pg_trgm index created for substring search');
  } catch (e) {
    console.log('pg_trgm not available, falling back to sequential scan for substring queries');
  }
  console.timeEnd('indexes');

  console.log('Database initialization complete.');
  return db;
}

module.exports = { initDB };
