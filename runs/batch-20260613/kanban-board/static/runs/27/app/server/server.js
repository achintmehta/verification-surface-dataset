import express from 'express';
import cors from 'cors';
import { initDb, db } from './db.js';

const app = express();
const PORT = 3000;

// SSE clients
let sseClients = new Set();

app.use(cors());
app.use(express.json());

// Initialize DB
await initDb();

// Helper to broadcast to all SSE clients
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// GET /api/board - return full board state
app.get('/api/board', async (req, res) => {
  try {
    const columnsResult = await db.query(
      'SELECT * FROM columns ORDER BY position'
    );
    const columns = columnsResult.rows;

    for (const column of columns) {
      const cardsResult = await db.query(
        'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
        [column.id]
      );
      column.cards = cardsResult.rows;
    }

    res.json({ columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

// POST /api/cards - create card at end of column
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
    const newPos = parseFloat(posResult.rows[0].max_pos) + 1000;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPos]
    );

    const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = cardResult.rows[0];

    // Broadcast
    broadcast('card-created', { card, columnId });

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
    await db.exec('BEGIN');

    // Get current card to know old column
    const currentResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const currentCard = currentResult.rows[0];
    const oldColumnId = currentCard.column_id;

    // Compute new position
    // beforeId: card that should be immediately before moved card
    // afterId: card that should be immediately after moved card
    let newPosition;
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      const beforePos = beforeRes.rows[0]?.position || 0;
      const afterPos = afterRes.rows[0]?.position || 10000;
      newPosition = (beforePos + afterPos) / 2;
    } else if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const beforePos = beforeRes.rows[0]?.position || 0;
      newPosition = beforePos + 1;
    } else if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      const afterPos = afterRes.rows[0]?.position || 10000;
      newPosition = afterPos - 1;
    } else {
      // End of column
      const maxRes = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      newPosition = parseFloat(maxRes.rows[0].max_pos) + 1000;
    }

    // Check for collision/precision issues (simple threshold)
    const needsRenorm = Math.abs(newPosition % 1) < 0.0001 && newPosition !== Math.floor(newPosition);

    // Update card
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    // Handle renormalization if needed
    if (needsRenorm || (newPosition > 1e10 || newPosition < -1e10)) {
      await renormalizeColumn(columnId);
    }

    await db.exec('COMMIT');

    // Fetch updated card
    const updatedResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedResult.rows[0];

    // Broadcast the move
    broadcast('card-moved', { 
      card: updatedCard, 
      columnId, 
      oldColumnId 
    });

    res.json(updatedCard);
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

async function renormalizeColumn(columnId) {
  const cardsRes = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;
  
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [newPos, cards[i].id]
    );
  }
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.add(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});