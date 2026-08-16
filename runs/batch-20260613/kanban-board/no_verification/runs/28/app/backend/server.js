import express from 'express';
import cors from 'cors';
import { initDb, db } from './db.js';
import { randomUUID } from 'crypto';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// SSE clients
let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    client.write(payload);
  });
}

async function getBoardState() {
  const { rows: columns } = await db.query(
    'SELECT * FROM columns ORDER BY position'
  );
  
  const board = [];
  for (const col of columns) {
    const { rows: cards } = await db.query(
      'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
      [col.id]
    );
    board.push({
      ...col,
      cards
    });
  }
  return board;
}

// Initialize DB
await initDb();

// GET /api/board
app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cards
app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Find max position in column
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = parseFloat(maxRows[0].max_pos) + 1000;

    const cardId = randomUUID();
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [cardId, columnId, text, newPos]
    );

    const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = rows[0];

    broadcast('card-created', { card, columnId });
    res.status(201).json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/cards/:id/move
app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    await db.transaction(async (tx) => {
      // Get current card
      const { rows: currentRows } = await tx.query(
        'SELECT * FROM cards WHERE id = $1',
        [cardId]
      );
      if (currentRows.length === 0) {
        throw new Error('Card not found');
      }
      const currentCard = currentRows[0];

      // Remove from old position (if moving columns, but we'll update anyway)
      // Compute new position
      let newPosition;
      if (beforeId && afterId) {
        const { rows: beforeRows } = await tx.query(
          'SELECT position FROM cards WHERE id = $1',
          [beforeId]
        );
        const { rows: afterRows } = await tx.query(
          'SELECT position FROM cards WHERE id = $1',
          [afterId]
        );
        if (beforeRows.length && afterRows.length) {
          newPosition = (parseFloat(beforeRows[0].position) + parseFloat(afterRows[0].position)) / 2;
        } else {
          newPosition = 1000;
        }
      } else if (beforeId) {
        const { rows: beforeRows } = await tx.query(
          'SELECT position FROM cards WHERE id = $1',
          [beforeId]
        );
        newPosition = beforeRows.length ? parseFloat(beforeRows[0].position) - 1000 : 1000;
      } else if (afterId) {
        const { rows: afterRows } = await tx.query(
          'SELECT position FROM cards WHERE id = $1',
          [afterId]
        );
        newPosition = afterRows.length ? parseFloat(afterRows[0].position) + 1000 : 1000;
      } else {
        // End of column
        const { rows: maxRows } = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = parseFloat(maxRows[0].max_pos) + 1000;
      }

      // Handle collision/precision
      if (isNaN(newPosition) || newPosition === Infinity || newPosition === -Infinity) {
        // Renormalize column
        const { rows: colCards } = await tx.query(
          'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position',
          [columnId]
        );
        for (let i = 0; i < colCards.length; i++) {
          await tx.query(
            'UPDATE cards SET position = $1 WHERE id = $2',
            [(i + 1) * 1000, colCards[i].id]
          );
        }
        newPosition = (colCards.length + 1) * 1000;
      }

      // Update card
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Check for collision in new position
      const { rows: collisionRows } = await tx.query(
        'SELECT COUNT(*) as cnt FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
        [columnId, newPosition, cardId]
      );
      if (parseInt(collisionRows[0].cnt) > 0) {
        // Renormalize
        const { rows: colCards } = await tx.query(
          'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
          [columnId]
        );
        for (let i = 0; i < colCards.length; i++) {
          await tx.query(
            'UPDATE cards SET position = $1 WHERE id = $2',
            [(i + 1) * 1000, colCards[i].id]
          );
        }
      }
    });

    // Get updated card
    const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = rows[0];

    broadcast('card-moved', { card, columnId });
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});