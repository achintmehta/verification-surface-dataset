import express from 'express';
import cors from 'cors';
import { initDb, db } from './db.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// SSE clients
let clients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((client) => {
    client.res.write(payload);
  });
}

// Initialize DB
await initDb();

// Get board state
app.get('/api/board', async (req, res) => {
  try {
    const columnsResult = await db.query(
      'SELECT * FROM columns ORDER BY position'
    );
    const columns = columnsResult.rows;

    for (const col of columns) {
      const cardsResult = await db.query(
        'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
        [col.id]
      );
      col.cards = cardsResult.rows;
    }

    res.json({ columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

// Create card
app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Find max position in column
    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = (posResult.rows[0].max_pos || 0) + 1000;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPos]
    );

    const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = cardResult.rows[0];

    broadcast('card-created', { card, columnId });
    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// Move card
app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    await db.transaction(async (tx) => {
      // Get current card
      const currentResult = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (currentResult.rows.length === 0) {
        throw new Error('Card not found');
      }
      const currentCard = currentResult.rows[0];

      // Remove from old position (if moving columns, but we'll update anyway)
      // Compute new position
      let newPosition;
      let needsRenorm = false;

      if (beforeId && afterId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        const beforePos = beforeRes.rows[0]?.position;
        const afterPos = afterRes.rows[0]?.position;

        if (beforePos != null && afterPos != null) {
          newPosition = (beforePos + afterPos) / 2;
          if (Math.abs(beforePos - afterPos) < 1e-9) {
            needsRenorm = true;
          }
        } else {
          newPosition = 1000;
        }
      } else if (beforeId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const beforePos = beforeRes.rows[0]?.position;
        newPosition = beforePos != null ? beforePos - 1000 : 1000;
      } else if (afterId) {
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        const afterPos = afterRes.rows[0]?.position;
        newPosition = afterPos != null ? afterPos + 1000 : 1000;
      } else {
        // End of column
        const maxRes = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = (maxRes.rows[0].max_pos || 0) + 1000;
      }

      // Update card
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      if (needsRenorm) {
        await renormalizeColumn(tx, columnId);
      }
    });

    // Fetch updated card
    const updatedResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedResult.rows[0];

    broadcast('card-moved', { card: updatedCard, columnId });
    res.json(updatedCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

async function renormalizeColumn(tx, columnId) {
  const cardsRes = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  req.on('close', () => {
    clients = clients.filter((c) => c.id !== clientId);
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});