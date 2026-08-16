import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(`file://${path.join(__dirname, 'kanban-db')}`);

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
  const count = parseInt(res.rows[0].count, 10);
  if (count === 0) {
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

  const client = { id: Date.now(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

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
    await db.query('BEGIN');
    
    let newPos = null;
    let needsRenormalization = false;

    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      const beforePos = beforeRes.rows[0]?.position;
      const afterPos = afterRes.rows[0]?.position;
      
      if (beforePos !== undefined && afterPos !== undefined) {
        newPos = (beforePos + afterPos) / 2;
        if (Math.abs(beforePos - afterPos) < 0.001) {
          needsRenormalization = true;
        }
      }
    } else if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const beforePos = beforeRes.rows[0]?.position;
      if (beforePos !== undefined) {
        newPos = beforePos - 1000;
      }
    } else if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      const afterPos = afterRes.rows[0]?.position;
      if (afterPos !== undefined) {
        newPos = afterPos + 1000;
      }
    }
    
    if (newPos === null) {
      const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
    }
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, id]
    );
    
    const updatedCard = updateRes.rows[0];

    if (needsRenormalization) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      const cards = cardsRes.rows;
      for (let i = 0; i < cards.length; i++) {
        const pos = (i + 1) * 1000;
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, cards[i].id]);
      }
    }

    await db.query('COMMIT');
    
    broadcast('card_moved', updatedCard);

    if (needsRenormalization) {
      const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
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
