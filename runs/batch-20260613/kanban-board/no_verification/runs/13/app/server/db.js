import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

export const db = new PGlite(DATA_DIR);

export async function initDb() {
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

    CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position);
  `);

  // Seed default columns if none exist.
  const existing = await db.query('SELECT COUNT(*)::int AS count FROM columns');
  if (existing.rows[0].count === 0) {
    const defaults = ['To Do', 'In Progress', 'Done'];
    for (let i = 0; i < defaults.length; i++) {
      await db.query(
        'INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)',
        [randomUUID(), defaults[i], (i + 1) * 1000]
      );
    }
  }
}

/**
 * Returns the full board: columns ordered by position, each with cards
 * ordered by position.
 */
export async function getBoard() {
  const cols = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const cards = await db.query(
    'SELECT id, column_id, text, position FROM cards ORDER BY position ASC, created_at ASC, id ASC'
  );

  const columns = cols.rows.map((c) => ({
    id: c.id,
    title: c.title,
    position: c.position,
    cards: []
  }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const card of cards.rows) {
    const col = byId.get(card.column_id);
    if (col) {
      col.cards.push({
        id: card.id,
        columnId: card.column_id,
        text: card.text,
        position: card.position
      });
    }
  }
  return { columns };
}
