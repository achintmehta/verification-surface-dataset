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
  const count = parseInt(rows[0].cnt, 10);

  if (count === 0) {
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Return all columns with their cards, ordered by position. */
export async function getBoardState() {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position'
  );

  const cardsByColumn = {};
  for (const col of columns) cardsByColumn[col.id] = [];
  for (const card of cards) {
    if (cardsByColumn[card.column_id]) {
      cardsByColumn[card.column_id].push(card);
    }
  }

  return columns.map(col => ({
    ...col,
    cards: cardsByColumn[col.id] ?? [],
  }));
}

/** Create a card at the end of a column. Returns the new card. */
export async function createCard(id, columnId, text) {
  // Find the current max position in the column
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const newPos = parseFloat(rows[0].maxpos) + 1000;

  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
    [id, columnId, text, newPos]
  );

  const { rows: created } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
    [id]
  );
  return created[0];
}

/**
 * Move a card to a new column and position.
 * beforeId / afterId are the neighbouring card ids (null = edge).
 * Returns { card, renormalized } where renormalized is an array of
 * { id, position } objects if the column was renormalized, else [].
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  // We run everything inside a transaction via sequential awaited queries.
  // PGLite is single-connection so this is safe.
  await db.exec('BEGIN');
  try {
    // Fetch neighbour positions
    let beforePos = null;
    let afterPos = null;

    if (afterId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1',
        [afterId]
      );
      if (rows.length) afterPos = parseFloat(rows[0].position);
    }
    if (beforeId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1',
        [beforeId]
      );
      if (rows.length) beforePos = parseFloat(rows[0].position);
    }

    // Compute new position
    let newPos;
    if (afterPos === null && beforePos === null) {
      // Only card in column
      newPos = 1000;
    } else if (afterPos === null) {
      // Insert before the first card
      newPos = beforePos - 1000;
    } else if (beforePos === null) {
      // Insert after the last card
      newPos = afterPos + 1000;
    } else {
      newPos = (afterPos + beforePos) / 2;
    }

    // Update the card
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPos, cardId]
    );

    // Fetch the updated card
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    const card = cardRows[0];

    // Check for position collisions / precision exhaustion in the target column
    const renormalized = await maybeRenormalize(columnId, newPos);

    await db.exec('COMMIT');

    // If renormalized, fetch the updated card position
    if (renormalized.length > 0) {
      const updated = renormalized.find(r => r.id === cardId);
      if (updated) card.position = updated.position;
    }

    return { card, renormalized };
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Check if the column needs renormalization (collision or precision exhaustion).
 * If so, evenly space all cards and return the new { id, position } list.
 * Must be called inside a transaction.
 */
async function maybeRenormalize(columnId, insertedPos) {
  const { rows } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  if (rows.length < 2) return [];

  // Detect collision: two cards with the same position
  let needsRenorm = false;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = parseFloat(rows[i].position);
    const b = parseFloat(rows[i + 1].position);
    if (b - a < 1e-9) {
      needsRenorm = true;
      break;
    }
  }

  // Detect precision exhaustion: gap too small to insert between
  if (!needsRenorm) {
    for (let i = 0; i < rows.length - 1; i++) {
      const a = parseFloat(rows[i].position);
      const b = parseFloat(rows[i + 1].position);
      if (b - a < 1e-6) {
        needsRenorm = true;
        break;
      }
    }
  }

  if (!needsRenorm) return [];

  // Renormalize: evenly space cards starting at 1000 with step 1000
  const updates = rows.map((row, idx) => ({
    id: row.id,
    position: (idx + 1) * 1000,
  }));

  for (const u of updates) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      u.position,
      u.id,
    ]);
  }

  console.log(`[db] Renormalized column ${columnId} (${updates.length} cards)`);
  return updates;
}
