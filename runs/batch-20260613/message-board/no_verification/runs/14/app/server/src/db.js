import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local file system so data survives restarts.
const DATA_DIR =
  process.env.PGDATA_DIR || path.join(__dirname, '..', 'pgdata');

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
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  return db;
}

/**
 * Fetch all historical messages, oldest first.
 */
export async function getMessages() {
  const { rows } = await db.query(
    'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC;'
  );
  return rows;
}

/**
 * Insert a new message and return the created row.
 */
export async function insertMessage(text) {
  const { rows } = await db.query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at;',
    [text]
  );
  return rows[0];
}
