import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local filesystem (relative to the server root).
// PGLite writes its data into this directory so messages survive restarts.
const DATA_DIR =
  process.env.PGLITE_DATA_DIR || path.resolve(__dirname, '..', 'pgdata');

let db;

/**
 * Initialise the embedded PGLite database and ensure the schema exists.
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

/**
 * Return the already-initialised database instance.
 * Throws if initDb() has not been called yet.
 */
export function getDb() {
  if (!db) {
    throw new Error('Database has not been initialised. Call initDb() first.');
  }
  return db;
}

/**
 * Fetch all messages ordered by creation time (oldest first).
 */
export async function getAllMessages() {
  const result = await getDb().query(
    'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC;'
  );
  return result.rows;
}

/**
 * Insert a new message and return the created row.
 */
export async function insertMessage(text) {
  const result = await getDb().query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at;',
    [text]
  );
  return result.rows[0];
}
