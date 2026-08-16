import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local file system so data survives restarts.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'board');

let dbInstance = null;

/**
 * Initialize the embedded PGLite database and ensure the schema exists.
 * Returns a singleton PGlite instance.
 */
export async function initDb() {
  if (dbInstance) return dbInstance;

  // PGLite does not create intermediate directories, so ensure the parent exists.
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  dbInstance = db;
  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDb() first.');
  }
  return dbInstance;
}

export { DATA_DIR };
