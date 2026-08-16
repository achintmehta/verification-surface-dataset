import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist PGLite to local disk so board state is durable across restarts.
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', '.data', 'pgdata');

fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });

export const db = new PGlite(DATA_DIR);

/**
 * Create schema and seed default columns (idempotent).
 */
export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id    TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position);
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM columns');
  if (rows[0].n === 0) {
    const defaults = [
      { id: 'col-todo', title: 'To Do', position: 1000 },
      { id: 'col-progress', title: 'In Progress', position: 2000 },
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

/**
 * Return the full board: columns ordered by position, each with its cards
 * ordered by position (id used as a deterministic tiebreaker).
 */
export async function getBoard() {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, id ASC'
  );

  const byColumn = new Map(columns.map((c) => [c.id, { ...c, cards: [] }]));
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }
  return Array.from(byColumn.values());
}
