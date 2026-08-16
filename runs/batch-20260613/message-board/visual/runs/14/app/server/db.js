import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the PGLite database to the local file system so data survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');

let dbInstance = null;

/**
 * Initialize the embedded PGLite database and ensure the schema exists.
 * Returns a singleton PGlite instance.
 */
export async function initDb() {
  if (dbInstance) return dbInstance;

  // Ensure the parent directory exists (PGlite's nodefs won't create
  // intermediate directories recursively).
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // PGlite writes to the given directory on disk.
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;

  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDb() first.');
  }
  return dbInstance;
}
