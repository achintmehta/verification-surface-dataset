import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data/pglite');

let db;

/**
 * Initialise the embedded PGLite instance and create the messages table
 * if it does not already exist.  The database files are persisted to the
 * local filesystem under <project-root>/data/pglite so that messages
 * survive server restarts.
 */
export async function initDb() {
  db = new PGlite(`file://${DATA_DIR}`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log(`[db] PGLite initialised – data directory: ${DATA_DIR}`);
  return db;
}

/**
 * Return the shared PGLite instance.  Throws if initDb() has not been
 * called yet so callers get a clear error rather than a silent undefined.
 */
export function getDb() {
  if (!db) {
    throw new Error('Database has not been initialised. Call initDb() first.');
  }
  return db;
}
