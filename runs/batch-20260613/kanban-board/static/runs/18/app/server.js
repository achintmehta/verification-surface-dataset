import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

let clients = [];

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
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
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM columns`);
  if (res.rows[0].count == 0) {
    await db.query(`INSERT INTO columns (title, position) VALUES ('To Do', 1000), ('In Progress', 2000), ('Done', 3000)`);
  }
}

app.get('/api/board', async (req, res) => {
  const columnsRes = await db.query(`SELECT * FROM columns ORDER BY position ASC`);
  const cardsRes = await db.query(`SELECT * FROM cards ORDER BY position ASC`);
  
  const board = columnsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(card => card.column_id === col.id)
  }));
  
  res.json(board);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  
  const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
  const maxPos = maxPosRes.rows[0].max_pos || 0;
  const newPos = maxPos + 1000;
  
  const insertRes = await db.query(
    `INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING *`,
    [columnId, text, newPos]
  );
  
  const newCard = insertRes.rows[0];
  broadcast('card_created', newCard);
  res.json(newCard);
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;
  
  await db.query('BEGIN');
  try {
    let prevPos = null;
    let nextPos = null;
    
    if (afterId) {
      const pRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
      if (pRes.rows.length > 0) prevPos = pRes.rows[0].position;
    }
    if (beforeId) {
      const nRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
      if (nRes.rows.length > 0) nextPos = nRes.rows[0].position;
    }
    
    let newPos;
    if (prevPos !== null && nextPos !== null) {
      newPos = (prevPos + nextPos) / 2;
    } else if (prevPos !== null) {
      newPos = prevPos + 1000;
    } else if (nextPos !== null) {
      newPos = nextPos - 1000;
    } else {
      newPos = 1000;
    }
    
    const updateRes = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *`,
      [columnId, newPos, cardId]
    );
    
    const updatedCard = updateRes.rows[0];
    
    let needsRenormalize = false;
    if (prevPos !== null && Math.abs(newPos - prevPos) < 0.001) needsRenormalize = true;
    if (nextPos !== null && Math.abs(nextPos - newPos) < 0.001) needsRenormalize = true;
    
    if (needsRenormalize) {
      const colCardsRes = await db.query(`SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
      for (let i = 0; i < colCardsRes.rows.length; i++) {
        const cid = colCardsRes.rows[i].id;
        const pos = (i + 1) * 1000;
        await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [pos, cid]);
        if (cid === cardId) {
          updatedCard.position = pos;
        }
      }
    }
    
    await db.query('COMMIT');
    
    if (needsRenormalize) {
      broadcast('column_renormalized', { columnId });
    } else {
      broadcast('card_moved', updatedCard);
    }
    
    res.json(updatedCard);
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const client = { id: Date.now(), res };
  clients.push(client);
  
  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});