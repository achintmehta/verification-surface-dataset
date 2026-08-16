import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persist board state durably to local disk.
const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, '..', 'data', 'kanban');

fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

export const db = new PGlite(DATA_DIR);

/**
 * Initialize schema and seed default columns if the board is empty.
 */
export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position
      ON cards (column_id, position);
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (rows[0].count === 0) {
    const defaults = [
      { id: 'col-todo', title: 'To Do', position: 1000 },
      { id: 'col-doing', title: 'In Progress', position: 2000 },
      { id: 'col-done', title: 'Done', position: 3000 },
    ];
    for (const c of defaults) {
      await db.query(
        'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
        [c.id, c.title, c.position]
      );
    }
  }
}
