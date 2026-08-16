/**
 * db.js
 * Initializes the embedded PGLite instance and creates the messages table.
 * PGLite persists data to the local filesystem under the ./data directory.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist data to <project-root>/backend/data so it survives server restarts.
const DATA_DIR = path.resolve(__dirname, '..', 'data');

let db;

/**
 * Returns the singleton PGlite instance, creating and initialising it on the
 * first call.  The messages table is created if it does not already exist.
 */
export async function getDb() {
  if (db) return db;

  db = new PGlite(`file://${DATA_DIR}`);

  // Wait for PGLite to be fully ready before running any queries.
  await db.waitReady;

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
