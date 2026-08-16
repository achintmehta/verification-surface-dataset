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
  clients.forEach(client => {
    client.res.write(payload);
  });
}

app.get('/api/board', async (req, res) => {
  try {
    const { rows: columns } = await db.query(
      'SELECT * FROM columns ORDER BY position'
    );
    const board = [];
    for (const col of columns) {
      const { rows: cards } = await db.query(
        'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
        [col.id]
      );
      board.push({ ...col, cards });
    }
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

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
    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPos]
    );
    const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = rows[0];
    broadcast('card-created', { card, columnId });
    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

async function computeNewPosition(columnId, beforeId, afterId) {
  let beforePos = null, afterPos = null;
  if (beforeId) {
    const { rows } = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
    if (rows.length) beforePos = parseFloat(rows[0].position);
  }
  if (afterId) {
    const { rows } = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
    if (rows.length) afterPos = parseFloat(rows[0].position);
  }

  let newPos;
  if (beforePos !== null && afterPos !== null) {
    newPos = (beforePos + afterPos) / 2;
  } else if (beforePos !== null) {
    newPos = beforePos + 1000;
  } else if (afterPos !== null) {
    newPos = afterPos - 1000;
  } else {
    // empty or end
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    newPos = parseFloat(maxRows[0].max_pos) + 1000;
  }

  // Check for collision or precision issues
  if (beforePos !== null && afterPos !== null && Math.abs(beforePos - afterPos) < 0.0001) {
    // Need to renormalize
    await renormalizeColumn(columnId);
    // Recompute after renormalize
    return await computeNewPosition(columnId, beforeId, afterId);
  }

  return newPos;
}

async function renormalizeColumn(columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }
  // Broadcast updated order? But caller will handle
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;
  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }
  try {
    await db.exec('BEGIN');
    // Get current card to know old column
    const { rows: currentRows } = await db.query('SELECT column_id FROM cards WHERE id = $1', [cardId]);
    if (currentRows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const oldColumnId = currentRows[0].column_id;

    const newPos = await computeNewPosition(columnId, beforeId, afterId);

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPos, cardId]
    );

    await db.exec('COMMIT');

    const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = rows[0];
    broadcast('card-moved', { card, columnId, oldColumnId });
    res.json(card);
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.push({ res });

  req.on('close', () => {
    clients = clients.filter(c => c.res !== res);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();