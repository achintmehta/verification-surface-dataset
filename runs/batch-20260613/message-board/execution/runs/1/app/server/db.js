import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist data to the local filesystem in a `data/` directory next to the server
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

/**
 * Initialise PGLite and create the messages table if it doesn't already exist.
 * Returns the shared db instance.
 */
export async function initDb() {
  if (db) return db;

  // Ensure the data directory exists before PGLite tries to open it
  mkdirSync(DATA_DIR, { recursive: true });

  console.log(`[db] Opening PGLite at: ${DATA_DIR}`);
  db = new PGlite(DATA_DIR);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log('[db] Database ready.');
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
