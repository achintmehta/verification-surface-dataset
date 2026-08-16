/**
 * Database module – initialises PGLite and exposes a ready promise.
 *
 * PGLite is an embedded PostgreSQL engine that persists to the local
 * filesystem.  We keep a single shared instance for the whole server
 * process so that all requests share the same connection and the same
 * in-process lock (PGLite is single-writer by design).
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _db = null;

/**
 * Return the shared PGLite instance, creating and initialising it on the
 * first call.  Subsequent calls return the same instance immediately.
 */
export async function getDb() {
  if (_db) return _db;

  _db = new PGlite(DATA_DIR);

  // Wait for the engine to be ready before running DDL.
  await _db.waitReady;

  await initSchema(_db);

  return _db;
}

// ---------------------------------------------------------------------------
// Schema & seed data
// ---------------------------------------------------------------------------

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      column_id  TEXT NOT NULL REFERENCES columns(id),
      text       TEXT NOT NULL,
      position   DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS cards_column_position
      ON cards (column_id, position);
  `);

  // Seed default columns only when the table is empty.
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM columns');
  const count = parseInt(rows[0].n, 10);

  if (count === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',       1000),
        ('col-inprogress',  'In Progress', 2000),
        ('col-done',        'Done',        3000);
    `);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short random ID that is URL-safe and collision-resistant enough
 * for a single-board application.
 */
export function newId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * Rules:
 *  - If both are null  → 1000 (first card in an empty column)
 *  - If after is null  → before + 1000 (append at end)
 *  - If before is null → after / 2      (prepend at start)
 *  - Otherwise         → midpoint
 *
 * Returns { position, needsRenorm } where needsRenorm is true when the gap
 * between the two neighbours is too small to safely insert another card later.
 */
export function computePosition(beforePos, afterPos) {
  const MIN_GAP = 1e-9;

  let position;

  if (beforePos == null && afterPos == null) {
    position = 1000;
  } else if (afterPos == null) {
    // Inserting after the last card.
    position = beforePos + 1000;
  } else if (beforePos == null) {
    // Inserting before the first card.
    position = afterPos / 2;
  } else {
    position = (beforePos + afterPos) / 2;
  }

  const gap =
    beforePos == null || afterPos == null
      ? Infinity
      : Math.abs(afterPos - beforePos);

  return { position, needsRenorm: gap < MIN_GAP };
}

/**
 * Renormalise all card positions in a column to evenly-spaced integers
 * (1000, 2000, 3000, …).  Returns the updated card rows so the caller can
 * broadcast the corrected order.
 */
export async function renormalizeColumn(db, columnId) {
  // Fetch cards in current order.
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId],
  );

  // Assign new positions inside a transaction.
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      const newPos = (i + 1) * 1000;
      await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
        newPos,
        rows[i].id,
      ]);
    }
  });

  // Return the freshly-ordered cards.
  const updated = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId],
  );
  return updated.rows;
}
