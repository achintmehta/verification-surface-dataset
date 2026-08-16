import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Persist PGLite to the local filesystem (server/data) so messages survive restarts.
const DATA_DIR = process.env.PGLITE_DATA_DIR || resolve(__dirname, '..', 'data');

let db;

/**
 * Initialize the embedded PGLite database and ensure the schema exists.
 * Returns the singleton PGlite instance.
 */
export async function initDb() {
  if (db) return db;

  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  return db;
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Fetch all messages ordered oldest -> newest.
 */
export async function getAllMessages() {
  const result = await getDb().query(
    'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
  );
  return result.rows;
}

/**
 * Insert a new message and return the created row.
 */
export async function insertMessage(text) {
  const result = await getDb().query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
    [text]
  );
  return result.rows[0];
}
