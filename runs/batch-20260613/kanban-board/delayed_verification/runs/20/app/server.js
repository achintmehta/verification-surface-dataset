import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

await db.query(`
  CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    position DOUBLE PRECISION NOT NULL
  );
`);

await db.query(`
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    column_id TEXT NOT NULL REFERENCES columns(id),
    text TEXT NOT NULL,
    position DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

const res = await db.query('SELECT count(*) as count FROM columns');
if (parseInt(res.rows[0].count) === 0) {
  await db.query(`INSERT INTO columns (id, title, position) VALUES 
    ('col-1', 'To Do', 1000),
    ('col-2', 'In Progress', 2000),
    ('col-3', 'Done', 3000)
  `);
}

const clients = new Set();

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.res.write(message);
  }
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  clients.add(client);

  req.on('close', () => {
    clients.delete(client);
  });
});

app.get('/api/board', async (req, res) => {
  const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC');
  const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC');
  
  const board = columnsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(card => card.column_id === col.id)
  }));
  
  res.json(board);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  const id = crypto.randomUUID();
  
  await db.query('BEGIN');
  try {
    const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
    const maxPos = maxPosRes.rows[0].max_pos || 0;
    const position = maxPos + 1000;
    
    const insertRes = await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, columnId, text, position]
    );
    
    const card = insertRes.rows[0];
    await db.query('COMMIT');
    broadcast({ type: 'CARD_CREATED', card });
    res.json(card);
  } catch (e) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  await db.query('BEGIN');
  try {
    let beforePos = null;
    let afterPos = null;
    
    if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (beforeRes.rows.length > 0) beforePos = beforeRes.rows[0].position;
    }
    if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (afterRes.rows.length > 0) afterPos = afterRes.rows[0].position;
    }

    if (afterId && !beforeId) {
      const nextRes = await db.query('SELECT position FROM cards WHERE column_id = $1 AND position > $2 ORDER BY position ASC LIMIT 1', [columnId, afterPos]);
      if (nextRes.rows.length > 0) {
        beforePos = nextRes.rows[0].position;
      }
    }
    if (beforeId && !afterId) {
      const prevRes = await db.query('SELECT position FROM cards WHERE column_id = $1 AND position < $2 ORDER BY position DESC LIMIT 1', [columnId, beforePos]);
      if (prevRes.rows.length > 0) {
        afterPos = prevRes.rows[0].position;
      }
    }

    let newPos;
    if (beforePos !== null && afterPos !== null) {
      newPos = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPos = beforePos - 1000;
    } else if (afterPos !== null) {
      newPos = afterPos + 1000;
    } else {
      newPos = 1000;
    }

    const collisionRes = await db.query('SELECT id FROM cards WHERE column_id = $1 AND position = $2', [columnId, newPos]);
    let needsRenormalization = collisionRes.rows.length > 0;
    
    if (beforePos !== null && Math.abs(newPos - beforePos) < 0.000001) needsRenormalization = true;
    if (afterPos !== null && Math.abs(newPos - afterPos) < 0.000001) needsRenormalization = true;
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, id]
    );
    
    const card = updateRes.rows[0];
    
    if (needsRenormalization) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
      let pos = 1000;
      for (const c of cardsRes.rows) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, c.id]);
        if (c.id === id) card.position = pos;
        pos += 1000;
      }
      const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      await db.query('COMMIT');
      broadcast({ type: 'COLUMN_RENORMALIZED', columnId, cards: updatedCardsRes.rows });
    } else {
      await db.query('COMMIT');
      broadcast({ type: 'CARD_MOVED', card });
    }
    
    res.json(card);
  } catch (e) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => {
  console.log('Server listening on port 3000');
});
