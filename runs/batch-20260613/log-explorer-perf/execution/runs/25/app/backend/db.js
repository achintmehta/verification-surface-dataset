const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { generateRows, generateBatchValues, TOTAL_ROWS, BATCH_SIZE } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db = null;

async function getDb() {
  if (db) return db;

  console.log('[db] Initializing PGLite...');
  db = new PGlite(DB_PATH);

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity VARCHAR(5) NOT NULL,
      service VARCHAR(64) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  const existingCount = countResult.rows[0].cnt;

  if (existingCount >= TOTAL_ROWS) {
    console.log(`[db] Table already has ${existingCount} rows, skipping seed.`);
  } else {
    if (existingCount > 0) {
      console.log(`[db] Partial seed detected (${existingCount} rows), truncating and re-seeding...`);
      await db.exec('TRUNCATE logs RESTART IDENTITY');
    }

    console.log(`[db] Seeding ${TOTAL_ROWS} rows...`);
    const startTime = Date.now();

    const rows = generateRows();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = generateBatchValues(rows, i, BATCH_SIZE);
      await db.query(batch.sql, batch.params);
      if ((i / BATCH_SIZE) % 10 === 0) {
        const pct = Math.round((i / rows.length) * 100);
        console.log(`[db] Seeded ${i}/${TOTAL_ROWS} (${pct}%)...`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[db] Seeding complete in ${elapsed}s`);

    // Create indexes after bulk insert for faster seeding
    console.log('[db] Creating indexes...');
    const idxStart = Date.now();

    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
    `);
    // For substring search, pg_trgm is not available in PGLite,
    // so we use a btree index on lower(message) for ordering support
    // and rely on the severity+ts index for combined queries.
    // The substring search will use sequential scan but filtered efficiently by severity first.
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs USING btree (lower(message) text_pattern_ops);
    `);

    const idxElapsed = ((Date.now() - idxStart) / 1000).toFixed(1);
    console.log(`[db] Indexes created in ${idxElapsed}s`);
  }

  // Ensure indexes exist on subsequent boots too
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_lower_message ON logs USING btree (lower(message) text_pattern_ops)`);

  return db;
}

module.exports = { getDb };
