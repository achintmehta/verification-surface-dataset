const express = require('express');
const cors = require('cors');
const { db, initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

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

async function renormalizeColumn(columnId) {
  await db.query('BEGIN');
  const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
  let pos = 1000;
  for (const card of cardsRes.rows) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
    pos += 1000;
  }
  await db.query('COMMIT');
  
  const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC', [columnId]);
  broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    await db.query('BEGIN');
    
    let newPos;
    let beforePos = null;
    let afterPos = null;

    if (beforeId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      beforePos = beforeRes.rows[0].position;
    }
    if (afterId) {
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      afterPos = afterRes.rows[0].position;
    }

    if (!beforeId && !afterId) {
      // Empty column
      newPos = 1000;
    } else if (!beforeId) {
      // Move to end
      newPos = afterPos + 1000;
    } else if (!afterId) {
      // Move to start
      newPos = beforePos / 2;
    } else {
      // Move between
      newPos = (beforePos + afterPos) / 2;
    }

    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    
    await db.query('COMMIT');
    
    const updatedCard = updateRes.rows[0];
    broadcast('card_moved', updatedCard);
    res.json(updatedCard);

    // Check for precision exhaustion or collision
    if (newPos < 0.0001 || (beforeId && afterId && Math.abs(newPos - beforePos) < 0.0001)) {
      await renormalizeColumn(columnId);
    }
  } catch (err) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
