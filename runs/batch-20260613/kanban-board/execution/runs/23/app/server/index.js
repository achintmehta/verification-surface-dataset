import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────

const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // precision threshold for renormalization

/**
 * Compute a position between `before` and `after`.
 * If either is null, place at the appropriate end.
 */
function midpoint(before, after) {
  if (before == null && after == null) return POSITION_GAP;
  if (before == null) return after / 2;
  if (after == null) return before + POSITION_GAP;
  return (before + after) / 2;
}

/**
 * Renormalize all card positions in a column to well-spaced integers.
 * Returns the updated cards.
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC',
    [columnId]
  );
  const updated = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards[i].position !== newPos) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
      updated.push({ id: cards[i].id, position: newPos });
    }
  }
  return updated;
}

// ─── SSE Endpoint ────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Send a comment to establish the connection
  res.write(':ok\n\n');
  addClient(res);
});

// ─── GET Board ───────────────────────────────────────────────

app.get('/api/board', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, created_at ASC'
    );

    // Group cards by column
    const cardsByCol = {};
    for (const col of columns) {
      cardsByCol[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByCol[card.column_id]) {
        cardsByCol[card.column_id].push(card);
      }
    }

    const board = columns.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByCol[col.id] || [],
    }));

    res.json(board);
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST Create Card ────────────────────────────────────────

app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const db = await getDb();

    // Verify column exists
    const { rows: cols } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (cols.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get the max position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].max_pos;
    const newPos = maxPos != null ? maxPos + POSITION_GAP : POSITION_GAP;

    const id = uuidv4();
    const { rows: inserted } = await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at',
      [id, columnId, text, newPos]
    );

    const card = inserted[0];
    broadcast('card_created', card);
    res.status(201).json(card);
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH Move Card ─────────────────────────────────────────

app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    let { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    // Ignore self-references
    if (afterId === id) afterId = null;
    if (beforeId === id) beforeId = null;

    const db = await getDb();

    // Use a transaction for atomicity
    await db.exec('BEGIN');

    try {
      // Verify card exists
      const { rows: cardRows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      if (cardRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      // Verify target column exists
      const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Column not found' });
      }

      // Get after and before positions
      let afterPos = null;
      let beforePos = null;

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length > 0) afterPos = rows[0].position;
      }

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length > 0) beforePos = rows[0].position;
      }

      // If neither reference card found in the target column, place at end or beginning
      if (afterId == null && beforeId == null) {
        // Place at end of column
        const { rows: maxRows } = await db.query(
          'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id]
        );
        const maxPos = maxRows[0].max_pos;
        afterPos = maxPos;
        beforePos = null;
      }

      let newPos = midpoint(afterPos, beforePos);

      // Check for collision or precision exhaustion
      let needsRenorm = false;
      if (afterPos != null && beforePos != null && Math.abs(beforePos - afterPos) < MIN_GAP) {
        needsRenorm = true;
      }

      // Also check for exact collision with existing positions
      if (!needsRenorm) {
        const { rows: collisionRows } = await db.query(
          'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
          [columnId, newPos, id]
        );
        if (collisionRows.length > 0) {
          needsRenorm = true;
        }
      }

      // Update the card atomically
      const { rows: updatedRows } = await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING id, column_id, text, position, created_at',
        [columnId, newPos, id]
      );

      if (needsRenorm) {
        await renormalizeColumn(db, columnId);
      }

      await db.exec('COMMIT');

      // If we renormalized, we need to get the final card state and broadcast full column
      if (needsRenorm) {
        const { rows: finalCard } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [id]
        );
        const { rows: colCards } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
          [columnId]
        );
        broadcast('column_renormalized', { columnId, cards: colCards });
        res.json(finalCard[0]);
      } else {
        const card = updatedRows[0];
        broadcast('card_moved', card);
        res.json(card);
      }
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE Card ─────────────────────────────────────────────

app.delete('/api/cards/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const { rows } = await db.query(
      'DELETE FROM cards WHERE id = $1 RETURNING id, column_id',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }
    broadcast('card_deleted', rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error('DELETE /api/cards/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Start ───────────────────────────────────────────────────

async function start() {
  await getDb(); // ensure DB is ready
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
