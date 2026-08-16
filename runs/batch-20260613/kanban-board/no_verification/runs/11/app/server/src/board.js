import { db } from './db.js';
import { randomUUID } from 'node:crypto';

// Gap used when appending a card to the end of a column.
const POSITION_STEP = 1000;
// If two adjacent positions differ by less than this, we can't safely
// insert a value strictly between them => renormalize the column.
const MIN_GAP = 1e-6;

/**
 * Return the full board: columns ordered by position, each with their
 * cards ordered by position.
 */
export async function getBoard() {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      ORDER BY column_id ASC, position ASC, created_at ASC`
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(serializeCard(card));
  }
  return { columns: columns.map((c) => byColumn.get(c.id)) };
}

export function serializeCard(row) {
  return {
    id: row.id,
    columnId: row.column_id,
    text: row.text,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

async function columnExists(client, columnId) {
  const { rows } = await client.query('SELECT 1 FROM columns WHERE id = $1', [
    columnId,
  ]);
  return rows.length > 0;
}

/**
 * Create a card at the end of the given column.
 */
export async function createCard({ columnId, text }) {
  const id = randomUUID();
  const trimmed = (text ?? '').toString();

  return db.transaction(async (tx) => {
    if (!(await columnExists(tx, columnId))) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }
    const { rows } = await tx.query(
      'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const max = rows[0].max == null ? 0 : Number(rows[0].max);
    const position = max + POSITION_STEP;

    const { rows: inserted } = await tx.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, trimmed, position]
    );
    return serializeCard(inserted[0]);
  });
}

/**
 * Compute a position strictly between afterPos and beforePos.
 * Either bound may be null (open-ended).
 * Returns { position, needsRenormalize }.
 */
function computeBetween(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    return { position: POSITION_STEP, needsRenormalize: false };
  }
  if (afterPos == null) {
    // Insert at the very top: below the first card.
    return { position: beforePos - POSITION_STEP, needsRenormalize: false };
  }
  if (beforePos == null) {
    // Insert at the very bottom: above the last card.
    return { position: afterPos + POSITION_STEP, needsRenormalize: false };
  }
  const gap = beforePos - afterPos;
  if (gap <= MIN_GAP) {
    // Precision exhaustion / collision: cannot safely fit between.
    return { position: (afterPos + beforePos) / 2, needsRenormalize: true };
  }
  return { position: afterPos + gap / 2, needsRenormalize: false };
}

/**
 * Renormalize all positions in a column to evenly spaced integers,
 * preserving the current order. Returns the canonical, ordered cards.
 */
async function renormalizeColumn(tx, columnId) {
  const { rows } = await tx.query(
    `SELECT id FROM cards
      WHERE column_id = $1
      ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId]
  );
  let pos = POSITION_STEP;
  for (const row of rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [
      pos,
      row.id,
    ]);
    pos += POSITION_STEP;
  }
}

/**
 * Move a card into a target column, positioned between afterId and beforeId.
 *
 * `afterId`  = the card that should end up immediately ABOVE the moved card.
 * `beforeId` = the card that should end up immediately BELOW the moved card.
 *
 * Performed atomically. Returns { card, column } where column contains the
 * canonical ordered cards of the affected target column (post-normalization
 * if needed).
 */
export async function moveCard({ cardId, columnId, beforeId, afterId }) {
  return db.transaction(async (tx) => {
    const { rows: existing } = await tx.query(
      'SELECT id, column_id FROM cards WHERE id = $1 FOR UPDATE',
      [cardId]
    );
    if (existing.length === 0) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    if (!(await columnExists(tx, columnId))) {
      const err = new Error('Target column not found');
      err.status = 404;
      throw err;
    }

    // Look up the positions of the neighbor cards *within the target column*.
    // Ignore neighbors that don't actually live in the target column or that
    // refer to the card being moved (stale client intent).
    async function neighborPos(neighborId) {
      if (!neighborId || neighborId === cardId) return null;
      const { rows } = await tx.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [neighborId, columnId]
      );
      return rows.length ? Number(rows[0].position) : null;
    }

    let afterPos = await neighborPos(afterId);
    let beforePos = await neighborPos(beforeId);

    // Guard against inverted bounds (stale intent): if afterPos >= beforePos,
    // drop the weaker constraint and let renormalization sort it out.
    if (afterPos != null && beforePos != null && afterPos >= beforePos) {
      beforePos = null;
    }

    let { position, needsRenormalize } = computeBetween(afterPos, beforePos);

    // Apply the move (remove-from-source + add-to-target happen as a single
    // UPDATE within this transaction, so the card is never in two columns).
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, position, cardId]
    );

    if (needsRenormalize) {
      await renormalizeColumn(tx, columnId);
    }

    // Read back the canonical state for the target column.
    const { rows: cardRows } = await tx.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards
        WHERE id = $1`,
      [cardId]
    );
    const card = serializeCard(cardRows[0]);

    const { rows: columnCards } = await tx.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards
        WHERE column_id = $1
        ORDER BY position ASC, created_at ASC, id ASC`,
      [columnId]
    );

    return {
      card,
      column: {
        id: columnId,
        cards: columnCards.map(serializeCard),
      },
    };
  });
}
