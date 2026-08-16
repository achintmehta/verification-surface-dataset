import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      column_id INTEGER REFERENCES columns(id),
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query('SELECT count(*) FROM columns');
  if (res.rows[0].count === '0' || res.rows[0].count === 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES
        ('To Do', 1000),
        ('In Progress', 2000),
        ('Done', 3000);
    `);
  }
}

initDb().catch(console.error);

let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c !== client);
  });
});

app.get('/api/board', async (req, res) => {
  try {
    const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC, id ASC');
    const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC, id ASC');
    
    const board = columnsRes.rows.map(col => ({
      ...col,
      cards: cardsRes.rows.filter(card => card.column_id === col.id)
    }));
    
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    
    const maxPosRes = await db.query(
      'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxPosRes.rows[0].max_pos || 0;
    const newPos = maxPos + 1000;
    
    const insertRes = await db.query(
      'INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING *',
      [columnId, text, newPos]
    );
    
    const newCard = insertRes.rows[0];
    broadcast('card_created', newCard);
    res.json(newCard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    await db.query('BEGIN');
    
    let beforePos = null;
    let afterPos = null;
    
    if (beforeId) {
      const bRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (bRes.rows.length > 0) beforePos = bRes.rows[0].position;
    }
    if (afterId) {
      const aRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (aRes.rows.length > 0) afterPos = aRes.rows[0].position;
    }
    
    let newPos;
    if (beforePos !== null && afterPos !== null) {
      newPos = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPos = beforePos - 1000;
    } else if (afterPos !== null) {
      newPos = afterPos + 1000;
    } else {
      const maxRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      newPos = (maxRes.rows[0].max_pos || 0) + 1000;
    }
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    
    const updatedCard = updateRes.rows[0];
    
    const minDiff = 0.0001;
    let needsRenormalize = false;
    if (beforePos !== null && Math.abs(beforePos - newPos) < minDiff) needsRenormalize = true;
    if (afterPos !== null && Math.abs(newPos - afterPos) < minDiff) needsRenormalize = true;
    
    if (needsRenormalize) {
      const cardsRes = await db.query(
        'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
        [columnId]
      );
      
      let pos = 1000;
      for (const card of cardsRes.rows) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
        if (card.id === cardId) {
          updatedCard.position = pos;
        }
        pos += 1000;
      }
      
      await db.query('COMMIT');
      
      const updatedCardsRes = await db.query(
        'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
        [columnId]
      );
      broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
    } else {
      await db.query('COMMIT');
      broadcast('card_moved', updatedCard);
    }
    
    res.json(updatedCard);
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
