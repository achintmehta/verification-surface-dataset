or) {
    await db.query('ROLLBACK');
    throw error;
  }

  const card = await getCard(id);
  const board = await getBoard();
  broadcast('mutation', { type: 'create', card, columnId: card.column_id, board });
  return { card, board };
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  let renormalized = false;

  await db.query('BEGIN');
  try {
    if (!(await columnExists(columnId))) {
      const err = new Error('Column not found');
      err.status = 404;
      throw err;
    }

    const card = await getCard(cardId);
    if (!card) {
      const err = new Error('Card not found');
      err.status = 404;
      throw err;
    }

    const before = await validateNeighbor(db, beforeId, columnId, cardId, 'beforeId');
    const after = await validateNeighbor(db, afterId, columnId, cardId, 'afterId');

    if (before && after && Number(after.position) >= Number(before.position)) {
      const err = new Error('afterId must come before beforeId in the target column');
      err.status = 400;
      throw err;
    }

    const position = computeBetween(after?.position ?? null, before?.position ?? null);
    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, position, cardId]);

    const collision = await db.query(
      'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id <> $3 LIMIT 1',
      [columnId, position, cardId]
    );

    if (positionIsUnsafe(position, after?.position ?? null, before?.position ?? null) || collision.rows.length > 0) {
      renormalized = true;
      await renormalizeColumn(db, columnId, cardId, afterId, beforeId);
    }

    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }

  const card = await getCard(cardId);
  const board = await getBoard();
  broadcast('mutation', { type: 'move', card, columnId: card.column_id, renormalized, board });
  return { card, board, renormalized };
}

app.get('/api/board', async (_req, res, 