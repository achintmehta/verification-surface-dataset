/**
 * db.js
 * Initializes the embedded PGLite instance and creates the messages table.
 * PGLite persists data to the local filesystem under ./data/pgdata.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'pgdata');

// Create a single shared PGlite instance that persists to disk.
const db = new PGlite(`file://${DATA_DIR}`);

/**
 * Run the schema migration: create the messages table if it does not exist.
 * Called once at server startup before any requests are handled.
 */
export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('[db] PGLite initialised – data directory:', DATA_DIR);
}

export default db;
