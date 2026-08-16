import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function initDb() {
  db = new PGlite(DATA_DIR);
  await db.waitReady;

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
  if (parseInt(rows[0].cnt, 10) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',       1000),
        ('col-inprogress',  'In Progress', 2000),
        ('col-done',        'Done',        3000);
    `);
  }

  console.log('[db] PGLite ready at', DATA_DIR);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

/**
 * Compute a position value between two neighbours.
 * If both are null, returns 1000.
 * If only afterPos is given (insert at end), returns afterPos + 1000.
 * If only beforePos is given (insert at start), returns beforePos / 2.
 * Otherwise returns the midpoint.
 */
export function computePosition(beforePos, afterPos) {
  if (beforePos == null && afterPos == null) return 1000;
  if (beforePos == null) return afterPos / 2;
  if (afterPos == null) return beforePos + 1000;
  return (beforePos + afterPos) / 2;
}

/**
 * Renormalize all card positions in a column to evenly-spaced integers.
 * Returns the updated cards.
 */
export async function renormalizeColumn(columnId) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const step = 1000;
  for (let i = 0; i < rows.length; i++) {
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [(i + 1) * step, rows[i].id]
    );
  }

  // Return fresh rows
  const updated = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );
  return updated.rows;
}

/**
 * Check whether positions in a column are too close (precision risk) and
 * renormalize if needed. Returns { renormalized: bool, cards: [] }.
 */
export async function maybeRenormalize(columnId) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  let needsRenorm = false;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].position - rows[i - 1].position;
    if (gap < 1e-9) {
      needsRenorm = true;
      break;
    }
  }

  if (needsRenorm) {
    const cards = await renormalizeColumn(columnId);
    return { renormalized: true, cards };
  }
  return { renormalized: false, cards: rows };
}
