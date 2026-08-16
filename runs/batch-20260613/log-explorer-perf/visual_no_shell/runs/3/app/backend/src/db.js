import { PGlite } from '@electric-sql/pglite';
import { generateSeedBatches } from './seed.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/pglite');

let db = null;

export async function initDb() {
  // Ensure data directory exists
  mkdirSync(DB_PATH, { recursive: true });

  console.log(`Initializing PGLite at ${DB_PATH}`);
  db = new PGlite(`file://${DB_PATH}`);

  await db.waitReady;
  console.log('PGLite ready');

  await setupSchema();
  await seedIfNeeded();

  return db;
}

async function setupSchema() {
  // Create the logs table if it doesn't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Index for ordering by ts (primary sort for all queries)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
  `);

  // Composite index for severity + ts ordering (severity filter queries)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // Index on service for service-based queries
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_service ON logs (service, ts DESC);
  `);

  // Functional index on lower(message) to speed up case-insensitive LIKE queries
  // This helps when the search term doesn't start with a wildcard (prefix searches)
  // For %term% patterns, PostgreSQL will still do a seq scan but with lower() pre-computed
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (lower(message));
  `);

  console.log('Schema and indexes ready');
}

async function seedIfNeeded() {
  const result = await db.query('SELECT COUNT(*) as count FROM logs');
  const count = parseInt(result.rows[0].count, 10);

  if (count >= 100000) {
    console.log(`Database already seeded with ${count} rows, skipping seed`);
    return;
  }

  if (count > 0) {
    console.log(`Partial seed detected (${count} rows), clearing and reseeding...`);
    await db.exec('TRUNCATE TABLE logs RESTART IDENTITY');
  }

  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();

  const batches = generateSeedBatches(100000, 1000);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    // Build a multi-row INSERT for the batch
    const valuePlaceholders = [];
    const values = [];
    let paramIdx = 1;

    for (const [ts, severity, service, message] of batch) {
      valuePlaceholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      values.push(ts, severity, service, message);
      paramIdx += 4;
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')}`;
    await db.query(sql, values);

    if ((batchIdx + 1) % 10 === 0) {
      console.log(`  Seeded ${(batchIdx + 1) * 1000} / 100000 rows...`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete in ${elapsed}s`);
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
