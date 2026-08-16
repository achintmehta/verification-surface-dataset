/**
 * Database layer: embedded PGLite instance persisted to local disk.
 *
 * PGLite runs a real PostgreSQL engine inside Node.js via WASM.
 * We point it at a local directory so data survives restarts.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pglite');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(`file://${DATA_DIR}`);
  await db.waitReady;
  return db;
}

/**
 * Create schema and seed default columns if they don't exist yet.
 */
export async function initDb() {
  const db = await getDb();

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
  const { rows } = await db.query(`SELECT COUNT(*) AS cnt FROM columns`);
  if (parseInt(rows[0].cnt, 10) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
        ('col-todo',        'To Do',       1000),
        ('col-inprogress',  'In Progress', 2000),
        ('col-done',        'Done',        3000);
    `);
    console.log('[db] Seeded default columns.');
  }

  console.log('[db] Database ready.');
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Return all columns with their cards, ordered by position.
 */
export async function getBoardState() {
  const db = await getDb();

  const { rows: columns } = await db.query(
    `SELECT id, title, position FROM columns ORDER BY position`
  );

  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY column_id, position`
  );

  // Group cards by column.
  const cardsByColumn = {};
  for (const col of columns) cardsByColumn[col.id] = [];
  for (const card of cards) {
    if (cardsByColumn[card.column_id]) {
      cardsByColumn[card.column_id].push(card);
    }
  }

  return columns.map((col) => ({
    ...col,
    cards: cardsByColumn[col.id],
  }));
}

/**
 * Compute a position value that places a card between `afterPos` and
 * `beforePos`.  Either bound may be null (meaning "at the start" or
 * "at the end").
 *
 * Uses the midpoint strategy.  If the gap is too small (< 1e-9) the
 * caller should renormalise the column.
 */
export function computePosition(afterPos, beforePos) {
  if (afterPos === null && beforePos === null) return 1000;
  if (afterPos === null) return beforePos / 2;
  if (beforePos === null) return afterPos + 1000;
  return (afterPos + beforePos) / 2;
}

const RENORM_STEP = 1000;

/**
 * Renormalise all card positions in a column to multiples of RENORM_STEP.
 * Returns the updated card rows.
 */
export async function renormalizeColumn(columnId) {
  const db = await getDb();

  const { rows: cards } = await db.query(
    `SELECT id FROM cards WHERE column_id = $1 ORDER BY position`,
    [columnId]
  );

  for (let i = 0; i < cards.length; i++) {
    await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [
      (i + 1) * RENORM_STEP,
      cards[i].id,
    ]);
  }

  // Return the freshly ordered cards.
  const { rows: updated } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards WHERE column_id = $1 ORDER BY position`,
    [columnId]
  );
  return updated;
}

/**
 * Create a new card at the end of a column.
 * Returns the inserted card row.
 */
export async function createCard(id, columnId, text) {
  const db = await getDb();

  // Find the current maximum position in the column.
  const { rows } = await db.query(
    `SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1`,
    [columnId]
  );
  const maxPos = rows[0].max_pos !== null ? parseFloat(rows[0].max_pos) : 0;
  const position = maxPos + 1000;

  await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)`,
    [id, columnId, text, position]
  );

  const { rows: inserted } = await db.query(
    `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
    [id]
  );
  return inserted[0];
}

/**
 * Move a card to a new column and position.
 *
 * `beforeId` – the card that will come AFTER the moved card (or null).
 * `afterId`  – the card that will come BEFORE the moved card (or null).
 *
 * The server computes the canonical position and persists atomically.
 * Returns { card, renormalized, cards } where `cards` is the full
 * column list if renormalisation occurred.
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const db = await getDb();

  // Run the entire move inside a transaction so no client ever sees
  // the card in two columns simultaneously.
  let card = null;
  let renormalized = false;
  let columnCards = null;

  await db.transaction(async (tx) => {
    // Verify the card exists.
    const { rows: cardRows } = await tx.query(
      `SELECT id FROM cards WHERE id = $1`,
      [cardId]
    );
    if (!cardRows.length) return; // card not found – card stays null

    // Fetch neighbour positions within the TARGET column.
    // We exclude the card being moved so its current position doesn't
    // interfere with the neighbour lookup.
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await tx.query(
        `SELECT position FROM cards WHERE id = $1 AND column_id = $2`,
        [afterId, columnId]
      );
      if (rows.length) afterPos = parseFloat(rows[0].position);
    }

    if (beforeId) {
      const { rows } = await tx.query(
        `SELECT position FROM cards WHERE id = $1 AND column_id = $2`,
        [beforeId, columnId]
      );
      if (rows.length) beforePos = parseFloat(rows[0].position);
    }

    const position = computePosition(afterPos, beforePos);

    // Atomic update: change column_id and position in one statement.
    await tx.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
      [columnId, position, cardId]
    );

    const { rows: updated } = await tx.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [cardId]
    );
    card = updated[0];

    // Check whether renormalisation is needed (gap too small).
    const GAP_THRESHOLD = 1e-9;
    if (afterPos !== null && beforePos !== null) {
      const gap = Math.abs(beforePos - afterPos);
      if (gap < GAP_THRESHOLD) {
        renormalized = true;
      }
    }
  });

  // Renormalise outside the transaction (it issues many UPDATEs).
  if (renormalized) {
    columnCards = await renormalizeColumn(columnId);
    // Refresh the moved card from the renormalised state.
    const { rows: fresh } = await db.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [cardId]
    );
    if (fresh.length) card = fresh[0];
  }

  return { card, renormalized, columnCards };
}
