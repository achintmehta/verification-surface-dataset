eturn Number(afterPosition) + POSITION_STEP;
  return (Number(afterPosition) + Number(beforePosition)) / 2;
}

function positionIsUnsafe(position, afterPosition, beforePosition) {
  if (!Number.isFinite(position)) return true;
  if (afterPosition != null && !(position > Number(afterPosition))) return true;
  if (beforePosition != null && !(position < Number(beforePosition))) return true;
  if (afterPosition != null && Math.abs(position - Number(afterPosition)) < 1e-9) return true;
  if (beforePosition != null && Math.abs(Number(beforePosition) - position) < 1e-9) return true;
  return false;
}

async function validateNeighbor(conn, neighborId, columnId, movedCardId, label) {
  if (!neighborId) return null;
  if (neighborId === movedCardId) return null;
  const result = await conn.query('SELECT id, position FROM cards WHERE id = $1 AND column_id = $2', [neighborId, columnId]);
  if (result.rows.length === 0) {
    const err = new Error(`${label} card is not in the target column`);
    err.status = 400;
    throw err;
  }
  return result.rows[0];
}

async function renormalizeColumn(conn, columnId, movedCardId, afterId, beforeId) {
  const result = await conn.query(
    'SELECT id FROM cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId, movedCardId]
  );
  const ids = result.rows.map((row) => row.id);

  let insertAt = ids.length;
  if (afterId && afterId !== movedCardId) {
    const index = ids.indexOf(afterId);
    if (index >= 0) insertAt = index + 1;
  } else if (beforeId && beforeId !== movedCardId) {
    const index = ids.indexOf(beforeId);
    if (index >= 0) insertAt = index;
  } else if (!afterId && beforeId && beforeId !== movedCardId) {
    const index = ids.indexOf(beforeId);
    if (index >= 0) insertAt = index;
  } else if (!afterId && !beforeId) {
    insertAt = ids.length;
  }

  ids.splice(insertAt, 0, movedCardId);
  let movedPosition = POSITION_STEP;
  for (let i = 0; i < ids.length; i++) {
    const position = (i + 1) * POSITION_STEP;
    await conn.query('UPDATE cards SET position = $1 WHERE id = $2', [position, ids[i]]);
    if (ids[i] === movedCardId) movedPosition = position;
  }
  return movedPosition;
}

async function createCard(columnId, text) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await db.query('BEGIN');
  try {
    if (!(await columnExists(columnId))) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }
    const maxResult = await db.query('SELECT MAX(position) AS max_position FROM cards WHERE column_id = $1', [columnId]);
    const maxPosition = maxResult.rows[0].max_position;
    const position = maxPosition == null ? POSITION_STEP : Number(maxPosition) + POSITION_STEP;
    await db.query(
      'INSERT INTO cards (id, column_id, text, position, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, columnId, text, position, createdAt]
    );
    await db.query('COMMIT');
  } catch (err