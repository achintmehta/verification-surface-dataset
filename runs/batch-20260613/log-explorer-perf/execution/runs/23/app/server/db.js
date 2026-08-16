const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const { generateRows, TOTAL_ROWS } = require('./seed');

const DB_PATH = path.join(__dirname, '..', 'pgdata');

let db = null;
let ready = false;

async function initDb() {
  if (db) return db;

  console.time('db:boot');
  db = new PGlite(DB_PATH);

  // Check if table exists and is populated
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'logs'
    ) AS table_exists
  `);

  const tableExists = tableCheck.rows[0].table_exists;
  let needsSeed = true;

  if (tableExists) {
    const countResult = await db.query('SELECT count(*)::int AS cnt FROM logs');
    const cnt = countResult.rows[0].cnt;
    if (cnt >= TOTAL_ROWS) {
      needsSeed = false;
      console.log(`Table 'logs' already has ${cnt} rows. Skipping seed.`);
    } else {
      console.log(`Table 'logs' has only ${cnt} rows. Re-seeding...`);
      await db.query('DROP TABLE IF EXISTS logs');
    }
  }

  if (needsSeed) {
    console.time('db:seed');

    // Create table
    await db.query(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(5) NOT NULL,
        service VARCHAR(64) NOT NULL,
        message TEXT NOT NULL
      )
    `);

    // Generate all rows
    const rows = generateRows();

    // Batch insert using multi-value INSERT statements
    const BATCH_SIZE = 500;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const placeholders = [];
      const values = [];
      let paramIdx = 1;

      for (const row of batch) {
        placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
        values.push(row.ts.toISOString(), row.severity, row.service, row.message);
        paramIdx += 4;
      }

      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${placeholders.join(', ')}`,
        values
      );

      if ((i + BATCH_SIZE) % 10000 === 0 || i + BATCH_SIZE >= rows.length) {
        console.log(`  Seeded ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length} rows`);
      }
    }

    console.timeEnd('db:seed');

    // Create indexes
    console.time('db:indexes');
    await db.query('CREATE INDEX idx_logs_ts ON logs (ts DESC)');
    await db.query('CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC)');
    // For substring search we use pg_trgm if available, otherwise we rely on
    // a lower(message) index. PGLite may not support pg_trgm, so we use a
    // functional index on lower(message) and rely on the query planner.
    // For ILIKE pattern matching, we create a text_pattern_ops index as well.
    await db.query('CREATE INDEX idx_logs_message_lower ON logs (lower(message) text_pattern_ops)');
    console.timeEnd('db:indexes');
  }

  ready = true;
  console.timeEnd('db:boot');
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function isReady() {
  return ready;
}

module.exports = { initDb, getDb, isReady };
