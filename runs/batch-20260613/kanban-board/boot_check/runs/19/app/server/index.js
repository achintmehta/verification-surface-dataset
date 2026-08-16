const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../client/dist')));
app.use(express.static(path.join(__dirname, '../client')));

const db = new PGlite('./kanban-db');

let clients = [];

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
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query('SELECT COUNT(*) as count FROM columns');
  if (parseInt(res.rows[0].count) === 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES
      ('To Do', 1000),
      ('In Progress', 2000),
      ('Done', 3000);
    `);
  }
}

initDb().catch(console.error);

app.get('/api/board', async (req, res) => {
  try {
    const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC');
    const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC');
    
    const columns = columnsRes.rows.map(col => ({
      ...col,
      cards: cardsRes.rows.filter(card => card.column_id === col.id)
    }));
    
    res.json(columns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;
  
  try {
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
      newPos = beforePos + 1000;
    } else if (afterPos !== null) {
      newPos = afterPos / 2;
    } else {
      newPos = 1000;
    }
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    
    const updatedCard = updateRes.rows[0];
    
    const collisionRes = await db.query(
      'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
      [columnId, newPos, cardId]
    );
    
    if (collisionRes.rows.length > 0 || (beforePos !== null && afterPos !== null && Math.abs(beforePos - afterPos) < 0.001)) {
      await db.transaction(async (tx) => {
        const allCardsRes = await tx.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
        for (let i = 0; i < allCardsRes.rows.length; i++) {
          const cId = allCardsRes.rows[i].id;
          const p = (i + 1) * 1000;
          await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [p, cId]);
        }
      });
      const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      broadcast({ type: 'COLUMN_RENORMALIZED', columnId, cards: updatedCardsRes.rows });
      res.json({ renormalized: true, cards: updatedCardsRes.rows });
      return;
    }
    
    broadcast({ type: 'CARD_MOVED', card: updatedCard });
    res.json(updatedCard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  clients.push(res);
  
  req.on('close', () => {
    clients = clients.filter(client => client !== res);
  });
});

function broadcast(data) {
  clients.forEach(client => {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
