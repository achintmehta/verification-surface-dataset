import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

// Embedded PGLite instance persisting to local disk.
export const db = new PGlite(DATA_DIR);

/**
 * Initialize the database schema and seed default columns.
 * Idempotent: safe to call on every boot.
 */
export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id);
  `);

  // Seed default columns only if the table is empty.
  const res = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (res.rows[0].count === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i++) {
      await db.query(
        'INSERT INTO columns (title, position) VALUES ($1, $2)',
        [defaults[i], (i + 1) * 1000]
      );
    }
  }
}
