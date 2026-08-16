import { Router } from 'express';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import crypto from 'crypto';

const router = Router();

// ─── SSE Stream ───────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  addClient(res);

  // Keep-alive every 15s
  const keepAlive = setInterval(() => {
    res.write(':ping\n\n');
  }, 15000);
  res.on('close', () => clearInterval(keepAlive));
});

// ─── GET /board ───────────────────────────────────────────────
router.get('/board', async (_req, res) => {
  try {
    const db = await getDb();
    const cols = await db.query('SELECT id, title, position FROM columns ORDER BY position');
    const cards = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position'
    );

    const columnMap = new Map();
    for (const col of cols.rows) {
      columnMap.set(col.id, { ...col, cards: [] });
    }
    for (const card of cards.rows) {
      const col = columnMap.get(card.column_id);
      if (col) col.cards.push(card);
    }

    res.json({ columns: Array.from(columnMap.values()) });
  } catch (err) {
    console.error('GET /board error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /cards ──────────────────────────────────────────────
router.post('/cards', async (req, res) => {
  try {
    const db = await getDb();
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    // Verify column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    const id = 'card-' + crypto.randomUUID();

    // Get max position in target column
    const maxPos = await db.query(
      'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const position = maxPos.rows[0].max_pos + 1000;

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, position]
    );

    const result = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );
    const card = result.rows[0];

    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /cards error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /cards/:id/move ────────────────────────────────────
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    // Verify column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Verify card exists
    const cardCheck = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Compute new position
    let newPosition;
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const r = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (r.rows.length > 0) afterPos = r.rows[0].position;
    }
    if (beforeId) {
      const r = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (r.rows.length > 0) beforePos = r.rows[0].position;
    }

    if (afterPos !== null && beforePos !== null) {
      // Insert between two cards
      newPosition = (afterPos + beforePos) / 2;
    } else if (afterPos !== null) {
      // Insert after the last reference card (end of subset)
      newPosition = afterPos + 1000;
    } else if (beforePos !== null) {
      // Insert before the first reference card (beginning)
      newPosition = beforePos / 2;
    } else {
      // Only card in column or no references: put at end
      const maxPos = await db.query(
        'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, cardId]
      );
      newPosition = maxPos.rows[0].max_pos + 1000;
    }

    // Atomic update of column_id and position
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    // Check for precision exhaustion / collision and renormalize if needed
    const renormalized = await maybeRenormalize(db, columnId);

    // Read back the canonical card
    const result = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );
    const card = result.rows[0];

    if (renormalized) {
      // Broadcast full column state so all clients get correct positions
      const allCards = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position',
        [columnId]
      );
      broadcast('column:renormalized', { columnId, cards: allCards.rows });
    } else {
      broadcast('card:moved', { card });
    }

    res.json({ card });
  } catch (err) {
    console.error('PATCH /cards/:id/move error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /cards/:id ────────────────────────────────────────
router.delete('/cards/:id', async (req, res) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;

    const cardCheck = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    await db.query('DELETE FROM cards WHERE id = $1', [cardId]);

    broadcast('card:deleted', { cardId, columnId: cardCheck.rows[0].column_id });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /cards/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Renormalization helper ───────────────────────────────────
const MIN_GAP = 0.001; // If two adjacent positions are closer than this, renormalize

async function maybeRenormalize(db, columnId) {
  const cards = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  if (cards.rows.length < 2) return false;

  let needsRenorm = false;
  for (let i = 1; i < cards.rows.length; i++) {
    const gap = cards.rows[i].position - cards.rows[i - 1].position;
    if (gap < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return false;

  // Renormalize: space cards evenly 1000 apart
  for (let i = 0; i < cards.rows.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards.rows[i].id]);
  }

  return true;
}

export default router;
