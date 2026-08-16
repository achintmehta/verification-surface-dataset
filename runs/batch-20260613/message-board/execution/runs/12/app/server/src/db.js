import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist PGLite data to a directory on the local filesystem.
// Located at server/pgdata so it survives restarts.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, '..', 'pgdata');

let dbPromise;

/**
 * Returns a singleton PGlite instance, initializing the schema on first use.
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
export function getDb() {
  if (!dbPromise) {
    dbPromise = initDb();
  }
  return dbPromise;
}

async function initDb() {
  const db = new PGlite(DATA_DIR);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log(`[db] PGLite initialized (data dir: ${DATA_DIR})`);
  return db;
}
