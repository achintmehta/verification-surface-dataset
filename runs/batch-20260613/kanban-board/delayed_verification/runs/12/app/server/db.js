import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PGLite persists to a directory on the local file system so board state
// is durable across restarts.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'pgdata');

fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

let db;

/**
 * Initialize the embedded PGLite database, create the schema if it does not
 * yet exist, and seed default columns.
 */
export async function initDb() {
  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns only when the board is empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i++) {
      await db.query(
        'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
        [`col-${i + 1}`, defaults[i], (i + 1) * 1000]
      );
    }
  }

  return db;
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}
