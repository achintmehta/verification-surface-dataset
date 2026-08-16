import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

// SSE clients
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
  const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC');
  const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC');
  
  const columns = columnsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(card => card.column_id === col.id)
  }));
  
  res.json(columns);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  
  // Get max position in column
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
});

async function renormalizeColumn(columnId) {
  // Fetch all cards in the column ordered by position
  const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
  const cards = cardsRes.rows;
  
  // Update positions to be 1000, 2000, 3000, etc.
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }
  
  // Broadcast the new order
  const updatedCardsRes = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
  broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    await db.exec('BEGIN');
    
    let newPos = 0;
    
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position, column_id FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position, column_id FROM cards WHERE id = $1', [afterId]);
      if (beforeRes.rows.length > 0 && afterRes.rows.length > 0 && beforeRes.rows[0].column_id == columnId && afterRes.rows[0].column_id == columnId) {
        const beforePos = beforeRes.rows[0].position;
        const afterPos = afterRes.rows[0].position;
        newPos = (beforePos + afterPos) / 2;
      } else {
        // Fallback to end of column
        const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
        newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
      }
    } else if (beforeId) {
      const beforeRes = await db.query('SELECT position, column_id FROM cards WHERE id = $1', [beforeId]);
      if (beforeRes.rows.length > 0 && beforeRes.rows[0].column_id == columnId) {
        const beforePos = beforeRes.rows[0].position;
        newPos = beforePos - 1000;
      } else {
        const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
        newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
      }
    } else if (afterId) {
      const afterRes = await db.query('SELECT position, column_id FROM cards WHERE id = $1', [afterId]);
      if (afterRes.rows.length > 0 && afterRes.rows[0].column_id == columnId) {
        const afterPos = afterRes.rows[0].position;
        newPos = afterPos + 1000;
      } else {
        const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
        newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
      }
    } else {
      // Empty column or fallback
      const maxPosRes = await db.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      newPos = (maxPosRes.rows[0].max_pos || 0) + 1000;
    }
    
    // Update card
    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, id]
    );
    
    const updatedCard = updateRes.rows[0];
    
    await db.exec('COMMIT');
    
    broadcast('card_moved', updatedCard);
    res.json(updatedCard);
    
    // Check for precision exhaustion or collision
    // If newPos is too close to another card, renormalize
    // For simplicity, we can check if the gap is less than 0.001
    let needsRenormalization = false;
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position, column_id FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position, column_id FROM cards WHERE id = $1', [afterId]);
      if (beforeRes.rows.length > 0 && afterRes.rows.length > 0 && beforeRes.rows[0].column_id == columnId && afterRes.rows[0].column_id == columnId) {
        const beforePos = beforeRes.rows[0].position;
        const afterPos = afterRes.rows[0].position;
        if (Math.abs(beforePos - afterPos) < 0.001) {
          needsRenormalization = true;
        }
      }
    }
    
    if (needsRenormalization) {
      await renormalizeColumn(columnId);
    }
    
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);
  
  req.on('close', () => {
    clients = clients.filter(client => client.id !== clientId);
  });
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server running on port 3000');
  });
});
