import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist data to ./data directory relative to the server package root
const DATA_DIR = path.resolve(__dirname, '../../data');

let db;

/**
 * Initialise PGLite (creates the data directory and the messages table if
 * they do not already exist) and return the shared database instance.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(`file://${DATA_DIR}`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL      PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log(`[db] PGLite initialised – data directory: ${DATA_DIR}`);
  return db;
}

/**
 * Return the already-initialised database instance.
 * Throws if initDb() has not been called yet.
 */
export function getDb() {
  if (!db) {
    throw new Error('Database has not been initialised. Call initDb() first.');
  }
  return db;
}
