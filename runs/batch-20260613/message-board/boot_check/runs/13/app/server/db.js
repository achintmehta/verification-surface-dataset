import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database to the local filesystem. PGLite stores its data
// in the given directory so messages survive server restarts.
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

let db;

/**
 * Initialize the embedded PGLite database and ensure the `messages`
 * table exists. Returns the singleton PGlite instance.
 */
export async function initDb() {
  if (db) return db;

  // PGLite's node filesystem does not create parent directories, so ensure
  // the data directory exists before opening the database.
  fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new PGlite(DATA_DIR);
  await db.ready;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  return db;
}

/**
 * Fetch all messages ordered by creation time (oldest first).
 */
export async function getMessages() {
  const database = await initDb();
  const result = await database.query(
    'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
  );
  return result.rows;
}

/**
 * Insert a new message and return the created row.
 */
export async function insertMessage(text) {
  const database = await initDb();
  const result = await database.query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
    [text]
  );
  return result.rows[0];
}
