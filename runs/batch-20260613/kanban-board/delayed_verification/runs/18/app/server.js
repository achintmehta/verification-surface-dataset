import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';

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
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const res = await db.query(`SELECT count(*) as count FROM columns`);
  if (Number(res.rows[0].count) === 0) {
    await db.query(`INSERT INTO columns (id, title, position) VALUES 
      ('col-1', 'To Do', 1000),
      ('col-2', 'In Progress', 2000),
      ('col-3', 'Done', 3000)
    `);
  }
}

app.get('/api/board', async (req, res) => {
  const colsRes = await db.query(`SELECT * FROM columns ORDER BY position ASC`);
  const cardsRes = await db.query(`SELECT * FROM cards ORDER BY position ASC, created_at ASC, id ASC`);
  
  const board = colsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(c => c.column_id === col.id)
  }));
  
  res.json(board);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  const id = crypto.randomUUID();
  
  try {
    let needsRenormalization = false;
    let newCard;
    
    await db.transaction(async (tx) => {
      const maxPosRes = await tx.query(`SELECT max(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
      const maxPos = maxPosRes.rows[0].max_pos || 0;
      const position = maxPos + 1000;
      
      await tx.query(`INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)`, [id, columnId, text, position]);
      
      const collisionRes = await tx.query(`SELECT count(*) as count FROM cards WHERE column_id = $1 AND position = $2 AND id != $3`, [columnId, position, id]);
      needsRenormalization = collisionRes.rows[0].count > 0;
      
      if (!needsRenormalization) {
        const newCardRes = await tx.query(`SELECT * FROM cards WHERE id = $1`, [id]);
        newCard = newCardRes.rows[0];
      }
    });
    
    if (needsRenormalization) {
      await renormalizeColumn(columnId);
    } else {
      broadcast('card_created', newCard);
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function renormalizeColumn(columnId) {
  let updatedCards = [];
  await db.transaction(async (tx) => {
    const cardsRes = await tx.query(`SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC`, [columnId]);
    const cards = cardsRes.rows;
    
    for (let i = 0; i < cards.length; i++) {
      const newPos = (i + 1) * 1000;
      await tx.query(`UPDATE cards SET position = $1 WHERE id = $2`, [newPos, cards[i].id]);
    }
    
    const updatedCardsRes = await tx.query(`SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC`, [columnId]);
    updatedCards = updatedCardsRes.rows;
  });
  
  broadcast('column_renormalized', { columnId, cards: updatedCards });
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    let needsRenormalization = false;
    let updatedCard;
    
    await db.transaction(async (tx) => {
      let newPos;
      let beforePos = null;
      let afterPos = null;
      
      if (beforeId) {
        const beforeRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
        if (beforeRes.rows.length) beforePos = beforeRes.rows[0].position;
      }
      if (afterId) {
        const afterRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
        if (afterRes.rows.length) afterPos = afterRes.rows[0].position;
      }
      
      if (beforePos !== null && afterPos !== null) {
        newPos = (beforePos + afterPos) / 2;
      } else if (afterPos !== null) {
        newPos = afterPos + 1000;
      } else if (beforePos !== null) {
        newPos = beforePos / 2;
      } else {
        newPos = 1000;
      }
      
      await tx.query(`UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`, [columnId, newPos, id]);
      
      if (afterPos !== null && newPos - afterPos < 0.001) needsRenormalization = true;
      if (beforePos !== null && beforePos - newPos < 0.001) needsRenormalization = true;
      
      const collisionRes = await tx.query(`SELECT count(*) as count FROM cards WHERE column_id = $1 AND position = $2 AND id != $3`, [columnId, newPos, id]);
      if (collisionRes.rows[0].count > 0) needsRenormalization = true;
      
      if (!needsRenormalization) {
        const updatedCardRes = await tx.query(`SELECT * FROM cards WHERE id = $1`, [id]);
        updatedCard = updatedCardRes.rows[0];
      }
    });
    
    if (needsRenormalization) {
      await renormalizeColumn(columnId);
    } else {
      broadcast('card_moved', updatedCard);
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const client = { id: crypto.randomUUID(), res };
  clients.push(client);
  
  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

initDb().then(() => {
  app.listen(3000, () => console.log('Server running on port 3000'));
});
