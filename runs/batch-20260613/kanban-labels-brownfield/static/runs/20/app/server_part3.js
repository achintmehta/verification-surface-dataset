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

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoard());
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { columnId, text } = req.body || {};
    if (!columnId || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }
    const result = await createCard(columnId, text.trim().slice(0, 500));
    res.status(201).json(result.card);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const { columnId, beforeId = null, afterId = null } = req.body || {};
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    const result = await moveCard(req.params.id, columnId, beforeId, afterId);
    res.json(result.card);
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  clients.add(res);
  sendSse(res, 'connected', { ok: true });

  const heartbeat = setInterval(() => {
    try {
      sendSse(res, 'heartbeat', { now: Date.now() });
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

await initDb();
app.listen(PORT, () => {
  console.log(`Kanban API listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
