import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local file system so data survives restarts.
// Resolves to <repo>/server/pgdata by default, configurable via PGDATA_DIR.
const DATA_DIR =
  process.env.PGDATA_DIR || path.resolve(__dirname, '..', 'pgdata');

let dbInstance = null;

/**
 * Initialize (once) the embedded PGLite database and ensure the schema exists.
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
export async function initDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  // Create the messages table (id, text, created_at) if it does not exist.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  dbInstance = db;
  console.log(`[db] PGLite ready, persisting to ${DATA_DIR}`);
  return dbInstance;
}

/**
 * Get the already-initialized database instance.
 * @returns {import('@electric-sql/pglite').PGlite}
 */
export function getDb() {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDb() first.');
  }
  return dbInstance;
}
