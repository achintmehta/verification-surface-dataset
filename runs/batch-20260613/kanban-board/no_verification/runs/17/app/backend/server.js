const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'kanban.db'));

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
      position REAL NOT NULL,
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
  const columnId = parseInt(req.body.columnId);
  const text = req.body.text;
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

async function renormalizeColumn(columnId) {
  try {
    const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
    let pos = 1000;
    for (const card of cardsRes.rows) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
      pos += 1000;
    }
    const updatedCards = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
    broadcast('column_renormalized', { columnId, cards: updatedCards.rows });
  } catch (err) {
    console.error('Renormalization failed', err);
  }
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const columnId = parseInt(req.body.columnId);
  const beforeId = req.body.beforeId ? parseInt(req.body.beforeId) : null;
  const afterId = req.body.afterId ? parseInt(req.body.afterId) : null;
  
  try {
    let newPos = 0;
    
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
      if (beforeRes.rows.length && afterRes.rows.length) {
        newPos = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
      } else {
        const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
        newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
      }
    } else if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
      if (beforeRes.rows.length) {
        newPos = beforeRes.rows[0].position - 1000;
      } else {
        const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
        newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
      }
    } else if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
      if (afterRes.rows.length) {
        newPos = afterRes.rows[0].position + 1000;
      } else {
        const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
        newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
      }
    } else {
      const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
    }
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    
    const updatedCard = updateRes.rows[0];
    broadcast('card_moved', updatedCard);
    res.json(updatedCard);
    
    // Check for precision issues or collisions
    // If newPos is too close to an integer or we have collisions, renormalize
    // For simplicity, we can check if the gap is too small
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
      if (beforeRes.rows.length && afterRes.rows.length) {
        const gap = beforeRes.rows[0].position - afterRes.rows[0].position;
        if (Math.abs(gap) < 0.001) {
          await renormalizeColumn(columnId);
        }
      }
    }
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});
