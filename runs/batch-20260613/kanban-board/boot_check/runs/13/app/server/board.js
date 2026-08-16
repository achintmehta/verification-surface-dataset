// Board data-access + ordering logic.
// Positions are fractional DOUBLE PRECISION values. To insert between two cards
// we take the midpoint of their positions. If the gap is too small to represent
// reliably, we renormalize the whole column.

const MIN_GAP = 1e-6; // below this we renormalize to avoid precision exhaustion
const STEP = 1000; // spacing used when renormalizing / appending

export async function getBoard(db) {
  const { rows: columns } = await db.query(
    'SELECT id, title, position FROM columns ORDER BY position ASC, id ASC'
  );
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, id ASC'
  );

  const byColumn = new Map();
  for (const col of columns) {
    byColumn.set(col.id, { ...col, cards: [] });
  }
  for (const card of cards) {
    const col = byColumn.get(card.column_id);
    if (col) col.cards.push(card);
  }
  return columns.map((c) => byColumn.get(c.id));
}

// Append a new card at the end of a column.
export async function createCard(db, columnId, text) {
  const colId = Number(columnId);
  const { rows } = await db.query(
    'SELECT MAX(position) AS max FROM cards WHERE column_id = $1',
    [colId]
  );
  const max = rows[0].max == null ? 0 : Number(rows[0].max);
  const position = max + STEP;
  const { rows: inserted } = await db.query(
    'INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING id, column_id, text, position, created_at',
    [colId, text, position]
  );
  return inserted[0];
}

// Compute a position between afterPos and beforePos.
// afterPos = position of card the moved card should come AFTER (above it in list)
// beforePos = position of card the moved card should come BEFORE (below it in list)
function midpoint(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return STEP; // empty column
  if (afterPos == null) return Number(beforePos) - STEP; // at the top
  if (beforePos == null) return Number(afterPos) + STEP; // at the bottom
  return (Number(afterPos) + Number(beforePos)) / 2;
}

// Renormalize a column while forcing the moved card to sit between afterId and
// beforeId, so the intended order is preserved even when float positions
// collided. Cards keep their current relative order otherwise.
async function renormalizeColumnWithIntent(db, columnId, cardId, beforeId, afterId) {
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  // Remove the moved card from the natural ordering, then re-insert at intent.
  const order = rows.map((r) => Number(r.id)).filter((id) => id !== Number(cardId));

  let insertIdx = order.length;
  if (beforeId != null && order.includes(Number(beforeId))) {
    insertIdx = order.indexOf(Number(beforeId));
  } else if (afterId != null && order.includes(Number(afterId))) {
    insertIdx = order.indexOf(Number(afterId)) + 1;
  }
  order.splice(insertIdx, 0, Number(cardId));

  for (let i = 0; i < order.length; i++) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      (i + 1) * STEP,
      order[i],
    ]);
  }
}

// Move a card into a column, positioned between afterId and beforeId.
// Performed atomically. Returns { card, columnId, renormalized, columnCards? }.
export async function moveCard(db, cardId, columnId, beforeId, afterId) {
  const cid = Number(cardId);
  const targetColumn = Number(columnId);

  let result;
  await db.exec('BEGIN');
  try {
    // Verify the card exists.
    const { rows: existing } = await db.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [cid]
    );
    if (existing.length === 0) {
      await db.exec('ROLLBACK');
      return null;
    }

    // Verify target column exists.
    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [targetColumn]
    );
    if (colRows.length === 0) {
      await db.exec('ROLLBACK');
      return null;
    }

    // Read neighbor positions from the target column. Ignore the card itself.
    const afterPos = await neighborPos(db, targetColumn, afterId, cid);
    const beforePos = await neighborPos(db, targetColumn, beforeId, cid);

    let newPos = midpoint(afterPos, beforePos);
    let needRenorm = false;

    // Detect collision / precision exhaustion.
    if (
      !Number.isFinite(newPos) ||
      (afterPos != null && Math.abs(newPos - Number(afterPos)) < MIN_GAP) ||
      (beforePos != null && Math.abs(newPos - Number(beforePos)) < MIN_GAP)
    ) {
      needRenorm = true;
    }

    // Apply the move (column + position) atomically.
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [targetColumn, newPos, cid]
    );

    if (needRenorm) {
      // Build the explicit intended order (placing the moved card between
      // afterId and beforeId) and renormalize to clean, evenly spaced
      // positions so concurrent collisions resolve to a stable total order.
      await renormalizeColumnWithIntent(db, targetColumn, cid, beforeId, afterId);
    }

    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cid]
    );

    // Always return the full ordered column for the target so clients can
    // reconcile against canonical state, plus the source column if it differs.
    const sourceColumn = existing[0].column_id;
    const columnsToReturn = new Set([targetColumn, sourceColumn]);
    const columns = {};
    for (const c of columnsToReturn) {
      const { rows: ordered } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
        [c]
      );
      columns[c] = ordered;
    }

    await db.exec('COMMIT');
    result = {
      card: cardRows[0],
      columnId: targetColumn,
      sourceColumnId: sourceColumn,
      renormalized: needRenorm,
      columns,
    };
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

async function neighborPos(db, columnId, neighborId, excludeId) {
  if (neighborId == null) return null;
  const nid = Number(neighborId);
  if (Number.isNaN(nid) || nid === excludeId) return null;
  const { rows } = await db.query(
    'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
    [nid, columnId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].position);
}
