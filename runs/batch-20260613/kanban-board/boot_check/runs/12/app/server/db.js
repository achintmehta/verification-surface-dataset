import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist the database durably to local disk.
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

let db;

/**
 * Initialize the embedded PGLite database, create the schema if needed,
 * and seed default columns on first run.
 */
export async function initDb() {
  // PGLite's node filesystem does not create parent directories recursively,
  // so ensure the full path exists first.
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

  db = new PGlite(DATA_DIR);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         SERIAL PRIMARY KEY,
      column_id  INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns only if the table is empty.
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i++) {
      await db.query('INSERT INTO columns (title, position) VALUES ($1, $2)', [
        defaults[i],
        (i + 1) * 1000,
      ]);
    }
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
