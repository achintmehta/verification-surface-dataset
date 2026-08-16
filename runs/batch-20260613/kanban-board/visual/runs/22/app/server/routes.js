import { Router } from 'express';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { computePosition, needsRenormalization, renormalize } from './ordering.js';
import crypto from 'crypto';

const router = Router();

// ---------- SSE Endpoint ----------
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  addClient(res);

  // Keep-alive every 30s
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

// ---------- GET /api/board ----------
router.get('/board', async (req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const col of columns) {
      cardsByColumn[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const board = columns.map(col => ({
      ...col,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json({ columns: board });
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// ---------- POST /api/cards ----------
router.post('/cards', async (req, res) => {
  try {
    const db = await getDb();
    const { columnId, text } = req.body;

    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    // Verify column exists
    const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get the max position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].max_pos;
    const position = computePosition(maxPos, null);

    const id = 'card-' + crypto.randomUUID();

    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];

    // Broadcast to all clients
    broadcast('card-created', { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// ---------- PATCH /api/cards/:id/move ----------
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    // Verify column exists
    const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Verify card exists and get its current column
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const sourceColumnId = cardRows[0].column_id;

    // Get all cards in the target column (excluding the moving card) sorted by position
    const { rows: colCards } = await db.query(
      'SELECT id, position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position ASC',
      [columnId, cardId]
    );

    // Resolve the positions of afterId and beforeId neighbors
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const neighbor = colCards.find(c => c.id === afterId);
      if (neighbor) afterPos = neighbor.position;
    }

    if (beforeId) {
      const neighbor = colCards.find(c => c.id === beforeId);
      if (neighbor) beforePos = neighbor.position;
    }

    // If neither neighbor was resolved, determine position from column state
    if (afterPos == null && beforePos == null) {
      if (colCards.length === 0) {
        // Column is empty (or card is the only one), place at default position
        // computePosition(null, null) returns POSITION_GAP
      } else if (!afterId && !beforeId) {
        // No neighbors specified - place at end
        afterPos = colCards[colCards.length - 1].position;
      } else if (afterId && !beforeId) {
        // afterId specified but not found (stale reference) - place at end
        afterPos = colCards[colCards.length - 1].position;
      } else if (!afterId && beforeId) {
        // beforeId specified but not found (stale reference) - place at beginning
        beforePos = colCards[0].position;
      }
    }

    const newPosition = computePosition(afterPos, beforePos);

    // Atomic transaction: update column_id and position
    await db.exec('BEGIN');
    try {
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );
      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    // Fetch the updated card
    const { rows: updatedRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    const updatedCard = updatedRows[0];

    // Check if we need renormalization for the target column
    const { rows: targetCards } = await db.query(
      'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
      [columnId]
    );

    let renormalizedCards = null;
    if (needsRenormalization(targetCards)) {
      const newPositions = renormalize(targetCards);
      await db.exec('BEGIN');
      try {
        for (const c of newPositions) {
          await db.query('UPDATE cards SET position = $1 WHERE id = $2', [c.position, c.id]);
        }
        await db.exec('COMMIT');
      } catch (txErr) {
        await db.exec('ROLLBACK');
        throw txErr;
      }
      // Fetch updated cards for the column
      const { rows: refreshed } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
        [columnId]
      );
      renormalizedCards = refreshed;

      // Also re-fetch the moved card for accurate position
      const { rows: refetchCard } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [cardId]
      );
      Object.assign(updatedCard, refetchCard[0]);
    }

    // Broadcast the move - only committed state
    broadcast('card-moved', {
      card: updatedCard,
      sourceColumnId,
      targetColumnId: columnId,
      renormalizedCards,
    });

    res.json({ card: updatedCard, renormalizedCards });
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// ---------- DELETE /api/cards/:id ----------
router.delete('/cards/:id', async (req, res) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;

    const { rows } = await db.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [cardId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const card = rows[0];
    await db.query('DELETE FROM cards WHERE id = $1', [cardId]);

    broadcast('card-deleted', { cardId, columnId: card.column_id });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/cards/:id error:', err);
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

export default router;
