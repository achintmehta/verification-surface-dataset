import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist data to the local filesystem in a "data" directory next to the server
const DATA_DIR = path.join(__dirname, '..', 'data');

let db;

/**
 * Initialise PGLite and create the messages table if it does not already exist.
 * Returns the shared db instance.
 */
export async function initDb() {
  if (db) return db;

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
 * Return the already-initialised db instance.
 * Throws if initDb() has not been called yet.
 */
export function getDb() {
  if (!db) throw new Error('Database has not been initialised. Call initDb() first.');
  return db;
}
