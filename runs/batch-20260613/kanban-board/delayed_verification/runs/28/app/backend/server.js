import express from 'express';
import cors from 'cors';
import { initDB, getDB, broadcast, addConnection } from './db.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize DB on startup
initDB().then(() => {
  console.log('PGLite database initialized');
}).catch(console.error);

// GET /api/board - return all columns with ordered cards
app.get('/api/board', async (req, res) => {
  try {
    const db = getDB();
    const { rows: columns } = await db.query(`
      SELECT id, title, position FROM columns ORDER BY position
    `);

    for (const col of columns) {
      const { rows: cards } = await db.query(`
        SELECT id, column_id, text, position, created_at 
        FROM cards 
        WHERE column_id = $1 
        ORDER BY position
      `, [col.id]);
      col.cards = cards;
    }

    res.json({ columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

// POST /api/cards - create card at end of column
app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text required' });
    }

    const db = getDB();
    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    // Get max position in column
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const position = (parseFloat(maxRows[0].max_pos) || 0) + 1000;

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, position]
    );

    const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = rows[0];

    // Broadcast
    broadcast({ type: 'card-created', card });

    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PATCH /api/cards/:id/move - move/reorder card
app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    const db = getDB();

    // Use transaction-like: query sequentially, but PGLite is single threaded mostly
    // First get the card's current info
    const { rows: cardRows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Compute new position
    let newPosition;
    const { rows: beforeRows } = beforeId 
      ? await db.query('SELECT position FROM cards WHERE id = $1', [beforeId])
      : { rows: [] };
    const { rows: afterRows } = afterId 
      ? await db.query('SELECT position FROM cards WHERE id = $1', [afterId])
      : { rows: [] };

    const beforePos = beforeRows[0]?.position;
    const afterPos = afterRows[0]?.position;

    if (beforePos != null && afterPos != null) {
      newPosition = (beforePos + afterPos) / 2;
    } else if (beforePos != null) {
      newPosition = beforePos - 1;  // or smaller step
    } else if (afterPos != null) {
      newPosition = afterPos + 1;
    } else {
      // At end of column
      const { rows: maxRows } = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      newPosition = (parseFloat(maxRows[0].max_pos) || 0) + 1000;
    }

    // Check for collision / precision issues (very close positions)
    const { rows: nearby } = await db.query(
      `SELECT id, position FROM cards 
       WHERE column_id = $1 AND id != $2 AND ABS(position - $3) < 0.0001`,
      [columnId, cardId, newPosition]
    );

    if (nearby.length > 0) {
      // Renormalize the column
      await renormalizeColumn(db, columnId);
      // Recompute position after renormalize
      const { rows: newBefore } = beforeId ? await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]) : { rows: [] };
      const { rows: newAfter } = afterId ? await db.query('SELECT position FROM cards WHERE id = $1', [afterId]) : { rows: [] };
      const nb = newBefore[0]?.position;
      const na = newAfter[0]?.position;
      if (nb != null && na != null) newPosition = (nb + na) / 2;
      else if (nb != null) newPosition = nb - 0.5;
      else if (na != null) newPosition = na + 0.5;
      else newPosition = 1000;

      // Broadcast renormalize
      const { rows: allCards } = await db.query(
        'SELECT * FROM cards WHERE column_id = $1 ORDER BY position', [columnId]
      );
      broadcast({ type: 'column-renormalized', columnId, cards: allCards });
    }

    // Update the card
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    const { rows: updatedRows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRows[0];

    // Broadcast canonical state
    broadcast({ type: 'card-moved', card: updatedCard });

    res.json(updatedCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  // Assign new positions 1000, 2000, ...
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  const remove = addConnection(res);

  req.on('close', () => {
    remove();
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});