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
      position  REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   REAL NOT NULL,
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
  if (!db) throw new Error('DB not initialized');
  return db;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a short random id */
export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Compute a position value between `after` and `before`.
 * If after is null  → place before `before` (use before - 1000).
 * If before is null → place after `after`  (use after  + 1000).
 * Both null         → use 1000.
 */
export function midpoint(after, before) {
  if (after == null && before == null) return 1000;
  if (after == null) return before - 1000;
  if (before == null) return after + 1000;
  return (after + before) / 2;
}

const PRECISION_THRESHOLD = 1e-9;

/**
 * Renormalize all card positions in a column to multiples of 1000.
 * Returns the updated cards array.
 */
export async function renormalizeColumn(columnId) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );
  for (let i = 0; i < rows.length; i++) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (i + 1) * 1000,
      rows[i].id,
    ]);
  }
  // Return fresh rows
  const result = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );
  return result.rows;
}

/**
 * Check whether the computed position is too close to an existing neighbour
 * (collision / precision exhaustion).
 */
export function needsRenormalization(pos, afterPos, beforePos) {
  if (afterPos != null && Math.abs(pos - afterPos) < PRECISION_THRESHOLD) return true;
  if (beforePos != null && Math.abs(pos - beforePos) < PRECISION_THRESHOLD) return true;
  return false;
}
