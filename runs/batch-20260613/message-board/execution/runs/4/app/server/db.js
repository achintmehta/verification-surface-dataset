import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist data to ./data directory relative to the server folder
const DATA_DIR = path.join(__dirname, '..', 'data');

let db;

/**
 * Initialise PGLite (creates the data directory if it doesn't exist)
 * and ensure the messages table exists.
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

  console.log(`[db] PGLite initialised – persisting to ${DATA_DIR}`);
  return db;
}

/**
 * Return the shared PGLite instance.
 * Throws if initDb() has not been called yet.
 */
export function getDb() {
  if (!db) {
    throw new Error('Database has not been initialised. Call initDb() first.');
  }
  return db;
}
