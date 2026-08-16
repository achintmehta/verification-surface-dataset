import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { randomUUID } from 'crypto';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

let clients = new Set();

async function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

app.get('/api/board', async (req, res) => {
  const db = getDb();
  const columnsResult = await db.query('SELECT * FROM columns ORDER BY position');
  const columns = columnsResult.rows;
  for (const col of columns) {
    const cardsResult = await db.query(
      'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
      [col.id]
    );
    col.cards = cardsResult.rows;
  }
  res.json({ columns });
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }
  const db = getDb();
  const id = randomUUID();
  // Find max position in column
  const posResult = await db.query(
    'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = posResult.rows[0].next_pos;
  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
    [id, columnId, text, position]
  );
  const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
  const card = cardResult.rows[0];
  await broadcast('card-created', { card, columnId });
  res.status(201).json(card);
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  const db = getDb();

  try {
    await db.exec('BEGIN');
    // Get current card
    const currentResult = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    if (currentResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const currentCard = currentResult.rows[0];
    const oldColumnId = currentCard.column_id;

    // Compute new position
    let newPosition;
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      const beforePos = beforeRes.rows[0]?.position || 0;
      const afterPos = afterRes.rows[0]?.position || 1000;
      newPosition = (beforePos + afterPos) / 2;
    } else if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      newPosition = beforeRes.rows[0]?.position - 1 || 0;
    } else if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      newPosition = (afterRes.rows[0]?.position || 0) + 1;
    } else {
      // end of column
      const maxRes = await db.query(
        'SELECT COALESCE(MAX(position), 0) + 1 as pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      newPosition = maxRes.rows[0].pos;
    }

    // Check for collision or precision issues (simplified renormalization)
    if (Math.abs(newPosition % 1) < 1e-10 || newPosition === 0) {  // rough check for exhaustion
      await renormalizeColumn(db, columnId);
      // recompute
      if (beforeId && afterId) {
        const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        newPosition = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
      } else {
        const maxRes = await db.query(
          'SELECT COALESCE(MAX(position), 0) + 1 as pos FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = maxRes.rows[0].pos;
      }
    }

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, id]
    );
    await db.exec('COMMIT');

    const updatedResult = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const updatedCard = updatedResult.rows[0];
    await broadcast('card-moved', { card: updatedCard, columnId, oldColumnId });
    res.json(updatedCard);
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Move failed' });
  }
});

async function renormalizeColumn(db, columnId) {
  const cardsRes = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;
  for (let i = 0; i < cards.length; i++) {
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [(i + 1) * 10, cards[i].id]
    );
  }
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();
