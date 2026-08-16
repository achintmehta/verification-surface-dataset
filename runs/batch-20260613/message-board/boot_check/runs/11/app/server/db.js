import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local filesystem so data survives restarts.
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

let dbInstance = null;

/**
 * Initialize (once) and return the embedded PGLite database instance.
 * Creates the `messages` table if it does not already exist.
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  // Ensure the data directory (and its parents) exist; PGLite's node fs layer
  // only performs a single-level mkdir.
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  dbInstance = db;
  return dbInstance;
}
