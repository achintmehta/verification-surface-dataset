import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local filesystem so data survives restarts.
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'pgdata');

let dbInstance = null;

/**
 * Returns a singleton PGlite instance, initializing the schema on first call.
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  dbInstance = db;
  return dbInstance;
}

/**
 * Creates the `messages` table if it does not already exist.
 * @param {import('@electric-sql/pglite').PGlite} db
 */
async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
