const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, 'db'));

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
      position DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      column_id INTEGER REFERENCES columns(id),
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
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

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c !== client);
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
    const insertRes = await db.query(
      `INSERT INTO cards (column_id, text, position) 
       VALUES ($1, $2, COALESCE((SELECT MAX(position) FROM cards WHERE column_id = $1), 0) + 1000) 
       RETURNING *`,
      [columnId, text]
    );
    
    const newCard = insertRes.rows[0];
    broadcast('card_created', newCard);
    res.json(newCard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function renormalizeColumn(columnId) {
  // Re-assign positions as 1000, 2000, 3000...
  await db.transaction(async (tx) => {
    const cardsRes = await tx.query(
      'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
      [columnId]
    );
    
    let pos = 1000;
    for (const row of cardsRes.rows) {
      await tx.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [pos, row.id]
      );
      pos += 1000;
    }
  });
  
  // Broadcast the whole column update
  const updatedCardsRes = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    let newPos;
    let updatedCard;
    
    await db.transaction(async (tx) => {
      // Helper to get max position
      const getMaxPos = async (colId) => {
        const res = await tx.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [colId]);
        return res.rows[0].max_pos || 0;
      };

      if (!beforeId && !afterId) {
        newPos = 1000;
      } else if (!beforeId) {
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
        if (afterRes.rows.length === 0) {
          newPos = (await getMaxPos(columnId)) + 1000;
        } else {
          newPos = afterRes.rows[0].position + 1000;
        }
      } else if (!afterId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
        if (beforeRes.rows.length === 0) {
          newPos = (await getMaxPos(columnId)) + 1000;
        } else {
          newPos = beforeRes.rows[0].position / 2;
        }
      } else {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
        if (beforeRes.rows.length === 0 || afterRes.rows.length === 0) {
          newPos = (await getMaxPos(columnId)) + 1000;
        } else {
          newPos = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
        }
      }
      
      const updateRes = await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
        [columnId, newPos, cardId]
      );
      updatedCard = updateRes.rows[0];
    });
    
    broadcast('card_moved', updatedCard);
    res.json(updatedCard);
    
    // Check for precision exhaustion or collision
    // If newPos is too close to another card, renormalize
    // For simplicity, if distance to nearest is < 0.001, renormalize
    // We can do this asynchronously after responding
    const checkRes = await db.query(
      `SELECT position FROM cards WHERE column_id = $1 AND id != $2 
       AND abs(position - $3) < 0.001`,
      [columnId, cardId, newPos]
    );
    if (checkRes.rows.length > 0) {
      await renormalizeColumn(columnId);
    }
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
});
