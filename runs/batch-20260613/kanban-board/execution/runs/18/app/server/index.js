import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../db');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(dbPath);

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

  const res = await db.query('SELECT COUNT(*) as count FROM columns');
  if (res.rows[0].count === '0' || res.rows[0].count === 0n || res.rows[0].count === 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES
      ('To Do', 1000),
      ('In Progress', 2000),
      ('Done', 3000);
    `);
  }
}

initDb().catch(console.error);

const clients = new Set();

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

app.get('/api/board', async (req, res) => {
  try {
    const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC, id ASC');
    const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC, id ASC');
    
    const columns = columnsRes.rows.map(col => ({
      ...col,
      cards: cardsRes.rows.filter(card => card.column_id === col.id)
    }));
    
    res.json(columns);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    
    const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
    const maxPos = maxPosRes.rows[0].max_pos || 0;
    const newPos = maxPos + 1000;
    
    const insertRes = await db.query(
      'INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING *',
      [columnId, text, newPos]
    );
    
    const newCard = insertRes.rows[0];
    broadcast({ type: 'CARD_CREATED', card: newCard });
    res.json(newCard);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
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
    
    let newPos;
    if (beforePos !== null && afterPos !== null) {
      newPos = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPos = beforePos - 1000;
    } else if (afterPos !== null) {
      newPos = afterPos + 1000;
    } else {
      const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      const maxPos = maxPosRes.rows[0].max_pos || 0;
      newPos = maxPos + 1000;
    }
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    const updatedCard = updateRes.rows[0];
    
    let needsRenormalization = false;
    if (beforePos !== null && Math.abs(beforePos - newPos) < 0.0001) needsRenormalization = true;
    if (afterPos !== null && Math.abs(newPos - afterPos) < 0.0001) needsRenormalization = true;
    
    if (needsRenormalization) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
      let currentPos = 1000;
      for (const card of cardsRes.rows) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [currentPos, card.id]);
        currentPos += 1000;
      }
      await db.query('COMMIT');
      
      const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
      broadcast({ type: 'COLUMN_RENORMALIZED', columnId, cards: updatedCardsRes.rows });
      const finalCard = updatedCardsRes.rows.find(c => c.id === cardId);
      res.json(finalCard);
    } else {
      await db.query('COMMIT');
      broadcast({ type: 'CARD_MOVED', card: updatedCard });
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
  
  clients.add(res);
  
  req.on('close', () => {
    clients.delete(res);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
