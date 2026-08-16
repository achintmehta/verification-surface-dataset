const express = require('express');
const cors = require('cors');
const { db, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const clients = new Set();

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
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
  try {
    const { columnId, text } = req.body;
    
    const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
    const maxPos = parseFloat(maxPosRes.rows[0].max_pos) || 0;
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
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;
  
  await db.exec('BEGIN');
  try {
    let beforePos = null;
    let afterPos = null;
    
    if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (beforeRes.rows.length > 0) beforePos = parseFloat(beforeRes.rows[0].position);
    }
    
    if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (afterRes.rows.length > 0) afterPos = parseFloat(afterRes.rows[0].position);
    }
    
    let newPos;
    if (beforePos !== null && afterPos !== null) {
      newPos = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPos = beforePos - 1000;
    } else if (afterPos !== null) {
      newPos = afterPos + 1000;
    } else {
      newPos = 1000;
    }
    
    let needsRenormalize = false;
    if (beforePos !== null && newPos === beforePos) needsRenormalize = true;
    if (afterPos !== null && newPos === afterPos) needsRenormalize = true;
    
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    
    const updatedCard = updateRes.rows[0];
    
    if (needsRenormalize) {
      const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      for (let i = 0; i < cardsRes.rows.length; i++) {
        const cId = cardsRes.rows[i].id;
        const p = (i + 1) * 1000;
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [p, cId]);
        if (cId === cardId) {
          updatedCard.position = p;
        }
      }
    }
    
    await db.exec('COMMIT');
    
    if (needsRenormalize) {
      const cardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      broadcast('column_renormalized', { columnId, cards: cardsRes.rows });
    } else {
      broadcast('card_moved', updatedCard);
    }
    
    res.json(updatedCard);
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(\`Server listening on port \${PORT}\`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});