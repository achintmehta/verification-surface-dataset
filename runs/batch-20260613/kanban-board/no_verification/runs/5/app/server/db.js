import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  return db;
}

export async function initDb() {
  const db = await getDb();

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      position  DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS cards_column_position ON cards(column_id, position);
  `);

  // Seed default columns if none exist
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM columns');
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',       1000),
        ('col-inprogress',  'In Progress', 2000),
        ('col-done',        'Done',        3000);
    `);
    console.log('[db] Seeded default columns.');
  }

  console.log('[db] Database ready at', DATA_DIR);
  return db;
}

/**
 * Generate a simple unique ID (timestamp + random suffix).
 */
export function newId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute a fractional position value to insert between two neighbours.
 *
 * @param {number|null} lowPos  - position of the card immediately ABOVE (lower value), or null
 * @param {number|null} highPos - position of the card immediately BELOW (higher value), or null
 *
 * Returns { position, needsRenorm } where needsRenorm is true when
 * the gap is too small to safely insert another item.
 */
export function computePosition(lowPos, highPos) {
  const MIN_GAP = 1e-9;

  let position;
  if (lowPos === null && highPos === null) {
    // Empty column
    position = 1000;
  } else if (lowPos === null) {
    // Insert before the first card
    position = highPos - 1000;
  } else if (highPos === null) {
    // Insert after the last card
    position = lowPos + 1000;
  } else {
    position = (lowPos + highPos) / 2;
  }

  const gap =
    lowPos !== null && highPos !== null
      ? Math.abs(highPos - lowPos)
      : Infinity;

  return { position, needsRenorm: gap < MIN_GAP };
}

/**
 * Renormalize all card positions in a column to evenly-spaced integers.
 * Returns the updated cards array.
 */
export async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const step = 1000;
  for (let i = 0; i < cards.length; i++) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (i + 1) * step,
      cards[i].id,
    ]);
  }

  // Return the freshly ordered cards
  const { rows: updated } = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );
  return updated;
}
