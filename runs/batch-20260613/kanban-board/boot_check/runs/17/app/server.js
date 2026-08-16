import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      column_id INTEGER REFERENCES columns(id),
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query('SELECT COUNT(*) as count FROM columns');
  if (res.rows[0].count == 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES
      ('To Do', 1000),
      ('In Progress', 2000),
      ('Done', 3000);
    `);
  }
}

app.get('/api/board', async (req, res) => {
  const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC');
  const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC, id ASC');
  
  const columns = columnsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(card => card.column_id === col.id)
  }));
  
  res.json(columns);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  
  const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
  const maxPos = maxPosRes.rows[0].max_pos || 0;
  const newPos = maxPos + 1000;
  
  const insertRes = await db.query(
    'INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING *',
    [columnId, text, newPos]
  );
  
  const newCard = insertRes.rows[0];
  broadcast('card_created', newCard);
  res.json(newCard);
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;
  
  let newPos = 0;
  let needsRenormalization = false;
  
  await db.query('BEGIN');
  try {
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (beforeRes.rows.length && afterRes.rows.length) {
        const posB = beforeRes.rows[0].position;
        const posA = afterRes.rows[0].position;
        newPos = (posB + posA) / 2;
        if (Math.abs(posB - posA) < 0.001) {
          needsRenormalization = true;
        }
      } else {
        // Fallback if one is missing
        const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
        newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
      }
    } else if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (beforeRes.rows.length) {
        newPos = beforeRes.rows[0].position - 1000;
      } else {
        newPos = 1000;
      }
    } else if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (afterRes.rows.length) {
        newPos = afterRes.rows[0].position + 1000;
      } else {
        newPos = 1000;
      }
    } else {
      const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
    }
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    
    if (updateRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    
    if (needsRenormalization) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
      let pos = 1000;
      for (const row of cardsRes.rows) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
        pos += 1000;
      }
    }
    
    await db.query('COMMIT');
    
    if (needsRenormalization) {
      const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
      broadcast('card_moved', updateRes.rows[0]);
      broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
      res.json(updateRes.rows[0]); // The position here might be outdated, but client will get the renormalized list
    } else {
      const updatedCard = updateRes.rows[0];
      broadcast('card_moved', updatedCard);
      res.json(updatedCard);
    }
  } catch (e) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

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

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
});
