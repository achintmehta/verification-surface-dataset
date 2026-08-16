const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

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
      position REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id),
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query('SELECT count(*) as count FROM columns');
  if (parseInt(res.rows[0].count) === 0) {
    await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [uuidv4(), 'To Do', 1000]);
    await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [uuidv4(), 'In Progress', 2000]);
    await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [uuidv4(), 'Done', 3000]);
  }
}

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

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { id: uuidv4(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    const id = uuidv4();
    
    const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
    const maxPos = maxPosRes.rows[0].max_pos || 0;
    const position = maxPos + 1000;

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, position]
    );

    const newCardRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const newCard = newCardRes.rows[0];

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

    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    if (cardRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }

    let newPosition;
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
      newPosition = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPosition = beforePos - 1000;
    } else if (afterPos !== null) {
      newPosition = afterPos + 1000;
    } else {
      const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      const maxPos = maxPosRes.rows[0].max_pos || 0;
      newPosition = maxPos + 1000;
    }

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, id]
    );

    const minDiff = 0.001;
    let needsRenormalization = false;
    if (beforePos !== null && Math.abs(beforePos - newPosition) < minDiff) needsRenormalization = true;
    if (afterPos !== null && Math.abs(newPosition - afterPos) < minDiff) needsRenormalization = true;

    if (needsRenormalization) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      let pos = 1000;
      for (const card of cardsRes.rows) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
        pos += 1000;
      }
    }

    await db.query('COMMIT');

    if (needsRenormalization) {
      const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
    } else {
      const updatedCardRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
      broadcast('card_moved', updatedCardRes.rows[0]);
    }

    const finalCardRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    res.json(finalCardRes.rows[0]);
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});
