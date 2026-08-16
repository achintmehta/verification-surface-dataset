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
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL
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
  if (parseInt(res.rows[0].count) === 0) {
    await db.query(`INSERT INTO columns (id, title, position) VALUES 
      ('col-1', 'To Do', 1000),
      ('col-2', 'In Progress', 2000),
      ('col-3', 'Done', 3000)
    `);
  }
}

initDb().catch(console.error);

app.get('/api/board', async (req, res) => {
  try {
    const colsRes = await db.query(`SELECT * FROM columns ORDER BY position ASC`);
    const cardsRes = await db.query(`SELECT * FROM cards ORDER BY position ASC`);
    
    const columns = colsRes.rows.map(col => ({
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
  const id = uuidv4();
  
  try {
    let card;
    await db.transaction(async (tx) => {
      const maxPosRes = await tx.query(
        `SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`,
        [columnId]
      );
      const maxPos = maxPosRes.rows[0].max_pos || 0;
      const position = maxPos + 1000;
      
      const insertRes = await tx.query(
        `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, columnId, text, position]
      );
      
      card = insertRes.rows[0];
    });
    
    broadcast('card_created', card);
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    let card;
    let needsRenormalization = false;
    let updatedCards = [];

    await db.transaction(async (tx) => {
      let newPosition;
      
      if (!beforeId && !afterId) {
        newPosition = 1000;
      } else if (!beforeId) {
        const afterRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
        if (afterRes.rows.length > 0) {
          newPosition = afterRes.rows[0].position + 1000;
        } else {
          newPosition = 1000;
        }
      } else if (!afterId) {
        const beforeRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
        if (beforeRes.rows.length > 0) {
          newPosition = beforeRes.rows[0].position / 2;
        } else {
          newPosition = 1000;
        }
      } else {
        const beforeRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
        const afterRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
        
        if (beforeRes.rows.length > 0 && afterRes.rows.length > 0) {
          newPosition = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
        } else {
          newPosition = 1000;
        }
      }
      
      if (beforeId && afterId) {
        const beforeRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
        const afterRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
        if (beforeRes.rows.length > 0 && afterRes.rows.length > 0) {
          const gap = beforeRes.rows[0].position - afterRes.rows[0].position;
          if (gap < 0.000001) {
            needsRenormalization = true;
          }
        }
      } else if (!afterId && beforeId) {
        const beforeRes = await tx.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
        if (beforeRes.rows.length > 0 && beforeRes.rows[0].position < 0.000001) {
          needsRenormalization = true;
        }
      }
      
      const updateRes = await tx.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *`,
        [columnId, newPosition, id]
      );
      
      if (updateRes.rows.length === 0) {
        throw new Error('Card not found');
      }
      
      card = updateRes.rows[0];
      
      if (needsRenormalization) {
        const cardsRes = await tx.query(
          `SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC`,
          [columnId]
        );
        
        let pos = 1000;
        for (const c of cardsRes.rows) {
          await tx.query(`UPDATE cards SET position = $1 WHERE id = $2`, [pos, c.id]);
          if (c.id === id) {
            card.position = pos;
          }
          pos += 1000;
        }
        
        const updatedCardsRes = await tx.query(
          `SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC`,
          [columnId]
        );
        updatedCards = updatedCardsRes.rows;
      }
    });
    
    if (needsRenormalization) {
      broadcast('column_renormalized', { columnId, cards: updatedCards });
    } else {
      broadcast('card_moved', card);
    }
    
    res.json(card);
  } catch (err) {
    res.status(err.message === 'Card not found' ? 404 : 500).json({ error: err.message });
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
