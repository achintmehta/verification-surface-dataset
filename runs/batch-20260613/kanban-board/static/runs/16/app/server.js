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
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      position REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      column_id UUID REFERENCES columns(id),
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query('SELECT count(*) FROM columns');
  if (parseInt(res.rows[0].count) === 0) {
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
  const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC');
  
  const board = columnsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(card => card.column_id === col.id)
  }));
  
  res.json(board);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  
  const maxPosRes = await db.query(
    'SELECT max(position) as max_pos FROM cards WHERE column_id = $1',
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
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  let newPos = 1000;
  
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
    
    if (beforePos !== null && afterPos !== null) {
      newPos = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPos = beforePos - 1000;
    } else if (afterPos !== null) {
      newPos = afterPos + 1000;
    } else {
      const maxPosRes = await db.query('SELECT max(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      if (maxPosRes.rows[0].max_pos !== null) {
        newPos = maxPosRes.rows[0].max_pos + 1000;
      }
    }
    
    let needsRenormalize = false;
    if (beforePos !== null && Math.abs(newPos - beforePos) < 0.001) needsRenormalize = true;
    if (afterPos !== null && Math.abs(newPos - afterPos) < 0.001) needsRenormalize = true;
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, id]
    );
    
    const updatedCard = updateRes.rows[0];
    
    if (needsRenormalize) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      let pos = 1000;
      for (const card of cardsRes.rows) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
        pos += 1000;
      }
      const finalRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
      Object.assign(updatedCard, finalRes.rows[0]);
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
  
  const client = { res };
  clients.push(client);
  
  req.on('close', () => {
    clients = clients.filter(c => c !== client);
  });
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});
