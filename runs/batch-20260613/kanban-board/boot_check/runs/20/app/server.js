import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./kanban-db');

// Initialize DB
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      position FLOAT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      column_id INTEGER REFERENCES columns(id),
      text TEXT NOT NULL,
      position FLOAT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query('SELECT COUNT(*) FROM columns');
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

// SSE Clients
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

  const client = { id: Date.now(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

app.get('/api/board', async (req, res) => {
  try {
    const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC');
    const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC, id ASC');
    
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

    broadcast('card_created', newCard);
    res.json(newCard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;

  try {
    await db.exec('BEGIN');
    
    let newPos = 0;
    let beforePos = null;
    let afterPos = null;
    
    if (beforeId) {
      const res = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (res.rows.length > 0) beforePos = res.rows[0].position;
    }
    if (afterId) {
      const res = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (res.rows.length > 0) afterPos = res.rows[0].position;
    }
    
    if (beforePos !== null && afterPos !== null) {
      newPos = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPos = beforePos + 1000;
    } else if (afterPos !== null) {
      newPos = afterPos - 1000;
    } else {
      const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
    }

    // Check for collision or precision exhaustion
    let needsRenormalize = false;
    if (beforePos !== null && Math.abs(newPos - beforePos) < 0.0001) needsRenormalize = true;
    if (afterPos !== null && Math.abs(newPos - afterPos) < 0.0001) needsRenormalize = true;

    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, id]
    );
    const updatedCard = updateRes.rows[0];

    if (needsRenormalize) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
      let pos = 1000;
      for (const card of cardsRes.rows) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
        if (card.id === updatedCard.id) {
          updatedCard.position = pos;
        }
        pos += 1000;
      }
      // Broadcast full column reorder
      const reorderedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
      broadcast('column_renormalized', { columnId, cards: reorderedCardsRes.rows });
    } else {
      broadcast('card_moved', updatedCard);
    }

    await db.exec('COMMIT');
    res.json(updatedCard);
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
