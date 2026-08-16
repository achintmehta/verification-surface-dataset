import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

/**
 * Initialise PGLite (persisted to disk) and create the messages table
 * if it does not already exist.
 */
export async function initDb() {
  db = new PGlite(`file://${DATA_DIR}`);

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

/**
 * Return all messages ordered from oldest to newest.
 */
export async function getMessages() {
  const result = await db.query(
    'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC'
  );
  return result.rows;
}

/**
 * Insert a new message and return the persisted row.
 */
export async function insertMessage(text) {
  const result = await db.query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
    [text]
  );
  return result.rows[0];
}
