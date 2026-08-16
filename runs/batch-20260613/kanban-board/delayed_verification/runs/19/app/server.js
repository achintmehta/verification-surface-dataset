import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { v4 as uuidv4 } from 'uuid';

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
      id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id UUID PRIMARY KEY,
      column_id UUID REFERENCES columns(id),
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM columns`);
  if (res.rows[0].count === '0' || res.rows[0].count === 0n || res.rows[0].count === 0) {
    await db.query(`INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)`, [uuidv4(), 'To Do', 1000]);
    await db.query(`INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)`, [uuidv4(), 'In Progress', 2000]);
    await db.query(`INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)`, [uuidv4(), 'Done', 3000]);
  }
}

initDb().catch(console.error);

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
  const id = uuidv4();
  
  await db.exec('BEGIN');
  try {
    const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
    const maxPos = maxPosRes.rows[0].max_pos || 0;
    const position = maxPos + 1000;
    
    await db.query(
      `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)`,
      [id, columnId, text, position]
    );
    
    const newCardRes = await db.query(`SELECT * FROM cards WHERE id = $1`, [id]);
    const newCard = newCardRes.rows[0];
    
    await db.exec('COMMIT');
    broadcast('card_created', newCard);
    res.json(newCard);
  } catch (e) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

async function renormalizeColumn(columnId) {
  const cardsRes = await db.query(`SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
  let pos = 1000;
  for (const card of cardsRes.rows) {
    await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [pos, card.id]);
    pos += 1000;
  }
  const updatedCardsRes = await db.query(`SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
  return { columnId, cards: updatedCardsRes.rows };
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  await db.exec('BEGIN');
  try {
    let newPosition;
    
    if (!beforeId && !afterId) {
      newPosition = 1000;
    } else if (!beforeId) {
      const afterRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
      newPosition = afterRes.rows.length > 0 ? afterRes.rows[0].position / 2 : 1000;
    } else if (!afterId) {
      const beforeRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
      newPosition = beforeRes.rows.length > 0 ? beforeRes.rows[0].position + 1000 : 1000;
    } else {
      const beforeRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
      const afterRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
      if (beforeRes.rows.length > 0 && afterRes.rows.length > 0) {
        newPosition = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
      } else if (beforeRes.rows.length > 0) {
        newPosition = beforeRes.rows[0].position + 1000;
      } else if (afterRes.rows.length > 0) {
        newPosition = afterRes.rows[0].position / 2;
      } else {
        newPosition = 1000;
      }
    }
    
    await db.query(`UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`, [columnId, newPosition, id]);
    
    let needsRenormalize = false;
    const collisionRes = await db.query(`SELECT id FROM cards WHERE column_id = $1 AND id != $2 AND abs(position - $3) < 0.001 LIMIT 1`, [columnId, id, newPosition]);
    if (collisionRes.rows.length > 0) {
      needsRenormalize = true;
    }
    
    let renormalizedData = null;
    if (needsRenormalize) {
      renormalizedData = await renormalizeColumn(columnId);
    }
    
    const updatedCardRes = await db.query(`SELECT * FROM cards WHERE id = $1`, [id]);
    const updatedCard = updatedCardRes.rows[0];
    
    await db.exec('COMMIT');
    
    if (needsRenormalize) {
      broadcast('column_renormalized', renormalizedData);
    } else {
      broadcast('card_moved', updatedCard);
    }
    
    res.json(updatedCard);
  } catch (e) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
