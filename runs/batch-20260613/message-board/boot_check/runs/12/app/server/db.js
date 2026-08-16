import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local file system so data survives restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'pgdata');

let dbInstance = null;

/**
 * Returns a singleton PGlite instance, initializing the schema on first use.
 */
export async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

  // Create the messages table if it does not yet exist.
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
