import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// Ensure the data directory exists before PGLite tries to use it
fs.mkdirSync(DATA_DIR, { recursive: true });

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

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------

/**
 * Compute a position value between `before` and `after`.
 * Either may be null (meaning "at the start" or "at the end").
 * `existingPositions` is the sorted list of all current positions in the column
 * (used to determine boundary values when before/after is null).
 */
export function computePosition(beforePos, afterPos) {
  if (beforePos === null && afterPos === null) {
    // Only card in column
    return 1000;
  }
  if (beforePos === null) {
    // Insert before the first card
    return afterPos / 2;
  }
  if (afterPos === null) {
    // Insert after the last card
    return beforePos + 1000;
  }
  return (beforePos + afterPos) / 2;
}

/**
 * Check whether the gap between two adjacent positions is too small
 * (less than Number.EPSILON * 1000 relative to the values).
 */
export function needsRenormalization(positions) {
  for (let i = 1; i < positions.length; i++) {
    const gap = positions[i] - positions[i - 1];
    if (gap < 1e-9) return true;
  }
  return false;
}

/**
 * Renormalize all card positions in a column to multiples of 1000.
 * Returns the updated rows: [{ id, position }].
 */
export async function renormalizeColumn(columnId) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );
  const updates = rows.map((r, i) => ({ id: r.id, position: (i + 1) * 1000 }));
  for (const u of updates) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [u.position, u.id]);
  }
  return updates;
}
