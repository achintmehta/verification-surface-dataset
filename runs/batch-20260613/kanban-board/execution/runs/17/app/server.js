import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';

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
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id),
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM columns`);
  if (parseInt(res.rows[0].count) === 0) {
    await db.query(`INSERT INTO columns (id, title, position) VALUES 
      ('col-1', 'To Do', 1000),
      ('col-2', 'In Progress', 2000),
      ('col-3', 'Done', 3000)
    `);
  }
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { id: crypto.randomUUID(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

app.get('/api/board', async (req, res) => {
  const colsRes = await db.query(`SELECT * FROM columns ORDER BY position ASC`);
  const cardsRes = await db.query(`SELECT * FROM cards ORDER BY position ASC`);
  
  const columns = colsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(card => card.column_id === col.id)
  }));
  
  res.json(columns);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  const id = crypto.randomUUID();
  
  const maxPosRes = await db.query(`SELECT max(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
  const maxPos = maxPosRes.rows[0].max_pos || 0;
  const position = maxPos + 1000;
  
  const insertRes = await db.query(
    `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, columnId, text, position]
  );
  
  const card = insertRes.rows[0];
  broadcast('card_created', card);
  res.json(card);
});

async function renormalizeColumn(columnId) {
  const cardsRes = await db.query(`SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
  const cards = cardsRes.rows;
  
  await db.exec('BEGIN');
  try {
    for (let i = 0; i < cards.length; i++) {
      const newPos = (i + 1) * 1000;
      await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [newPos, cards[i].id]);
    }
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
  
  const updatedCardsRes = await db.query(`SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
  broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    await db.exec('BEGIN');
    
    let beforePos = null;
    let afterPos = null;

    if (beforeId) {
      const bRes = await db.query(`SELECT position FROM cards WHERE id = $1 AND column_id = $2`, [beforeId, columnId]);
      if (bRes.rows.length > 0) beforePos = bRes.rows[0].position;
    }
    if (afterId) {
      const aRes = await db.query(`SELECT position FROM cards WHERE id = $1 AND column_id = $2`, [afterId, columnId]);
      if (aRes.rows.length > 0) afterPos = aRes.rows[0].position;
    }

    let position;
    if (beforePos === null && afterPos === null) {
      const maxRes = await db.query(`SELECT max(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
      position = (maxRes.rows[0].max_pos || 0) + 1000;
    } else if (beforePos === null) {
      position = afterPos + 1000;
    } else if (afterPos === null) {
      position = beforePos / 2;
    } else {
      position = (beforePos + afterPos) / 2;
    }
    
    const updateRes = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *`,
      [columnId, position, id]
    );
    
    await db.exec('COMMIT');
    
    const card = updateRes.rows[0];
    broadcast('card_moved', card);
    res.json(card);
    
    let needsRenormalization = false;
    if (beforePos !== null && Math.abs(beforePos - position) < 0.001) needsRenormalization = true;
    if (afterPos !== null && Math.abs(afterPos - position) < 0.001) needsRenormalization = true;
    
    if (needsRenormalization) {
      await renormalizeColumn(columnId);
    }
    
  } catch (e) {
    await db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});