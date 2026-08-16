import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persist PGLite data to the local filesystem so messages survive restarts.
// Allow overriding the directory via env var (useful for tests / deployments).
const DATA_DIR =
  process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'data', 'pgdata');

let dbInstance = null;

/**
 * Initialise (or return the already initialised) PGLite database.
 * Creates the `messages` table if it does not yet exist.
 */
export async function initDb() {
  if (dbInstance) return dbInstance;

  // Ensure the parent directory exists; PGLite's own mkdir is non-recursive.
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

/**
 * Fetch all messages ordered chronologically (oldest first).
 */
export async function getMessages(db) {
  const result = await db.query(
    'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC;'
  );
  return result.rows;
}

/**
 * Insert a new message and return the created row.
 */
export async function insertMessage(db, text) {
  const result = await db.query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at;',
    [text]
  );
  return result.rows[0];
}
