import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// PGLite persists to the local filesystem. The data directory lives alongside
// the server source so the database survives process restarts.
const DATA_DIR = join(__dirname, '..', 'pgdata');

let dbInstance = null;

/**
 * Lazily create (or reuse) the singleton PGLite instance and ensure the schema
 * exists. PGLite runs PostgreSQL embedded in the Node.js process via WASM.
 *
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
 * Create the `messages` table if it does not already exist.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 */
async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
