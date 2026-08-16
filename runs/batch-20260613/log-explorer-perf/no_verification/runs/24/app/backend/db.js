const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { generateSeedSQL } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

async function initDB() {
  console.log(`Initializing PGLite at ${DB_PATH}...`);
  const db = new PGlite(DB_PATH);

  // Check if the table already exists and is populated
  let needsSeed = true;
  try {
    const result = await db.query("SELECT COUNT(*) as cnt FROM logs");
    const count = parseInt(result.rows[0].cnt, 10);
    if (count >= 100000) {
      console.log(`Database already seeded with ${count} rows, skipping seed.`);
      needsSeed = false;
    } else if (count > 0) {
      console.log(`Found ${count} rows (incomplete), dropping and reseeding...`);
      await db.query("DROP TABLE IF EXISTS logs");
    }
  } catch (e) {
    // Table doesn't exist yet, that's fine
    console.log('No existing logs table found, will create and seed.');
  }

  if (needsSeed) {
    console.log('Creating schema...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(5) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      )
    `);

    console.log('Seeding 100,000 log entries...');
    console.time('seed');

    const BATCH_SIZE = 2000;
    const TOTAL = 100000;

    for (let batchStart = 0; batchStart < TOTAL; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL);
      const sql = generateSeedSQL(batchStart, batchEnd);
      await db.query(sql);
      if ((batchStart + BATCH_SIZE) % 10000 === 0 || batchEnd === TOTAL) {
        console.log(`  Seeded ${batchEnd} / ${TOTAL} rows...`);
      }
    }

    console.timeEnd('seed');

    console.log('Creating indexes...');
    console.time('indexes');

    // Index for ordering by timestamp (DESC)
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC)');

    // Composite index for severity + ts ordering
    await db.query('CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC, id DESC)');

    // pg_trgm or similar isn't available in PGLite, so we rely on ILIKE with 
    // the ts ordering index. For substring search, we'll use a functional approach.
    // A GIN trigram index would be ideal but PGLite may not support it.
    // We'll try creating one; if it fails, we fall back gracefully.
    try {
      await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await db.query('CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops)');
      console.log('  Created trigram index for message search');
    } catch (e) {
      console.log('  Trigram extension not available, substring search will use sequential filtering on indexed results');
    }

    // Analyze tables for query planner
    await db.query('ANALYZE logs');
    console.log('  Table analyzed');

    console.timeEnd('indexes');
    console.log('Database setup complete.');
  }

  return db;
}

module.exports = { initDB };
