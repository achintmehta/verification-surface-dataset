import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { config } from './config.js';

let db = null;

/**
 * Initialise the embedded PGLite database.
 *
 * PGLite runs a real PostgreSQL engine compiled to WASM directly inside the
 * Node.js process. We point it at a directory on the local filesystem so that
 * data is persisted across restarts.
 *
 * @returns {Promise<PGlite>} the initialised database instance
 */
export async function initDb() {
  if (db) return db;

  // Ensure the parent directory exists before PGLite tries to write to it.
  fs.mkdirSync(path.dirname(config.dataDir), { recursive: true });

  db = new PGlite(config.dataDir);
  await db.waitReady;

  // Create the messages table if it does not already exist.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  return db;
}

/**
 * Get the already-initialised database instance.
 * Throws if initDb() has not been called yet.
 *
 * @returns {PGlite}
 */
export function getDb() {
  if (!db) {
    throw new Error('Database has not been initialised. Call initDb() first.');
  }
  return db;
}
