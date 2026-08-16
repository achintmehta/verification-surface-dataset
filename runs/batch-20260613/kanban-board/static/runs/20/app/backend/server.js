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

  const res = await db.query(`SELECT count(*) as count FROM columns`);
  if (res.rows[0].count == 0) {
    await db.query(`INSERT INTO columns (id, title, position) VALUES 
      ('col-1', 'To Do', 1000),
      ('col-2', 'In Progress', 2000),
      ('col-3', 'Done', 3000)
    `);
  }
}

initDb().catch(console.error);

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

app.get('/api/board', async (req, res) => {
  try {
    const colsRes = await db.query(`SELECT * FROM columns ORDER BY position ASC`);
    const cardsRes = await db.query(`SELECT * FROM cards ORDER BY position ASC, id ASC`);
    
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
    const maxPosRes = await db.query(
      `SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`,
      [columnId]
    );
    const maxPos = maxPosRes.rows[0].max_pos || 0;
    const position = maxPos + 1000;

    const insertRes = await db.query(
      `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, columnId, text, position]
    );
    
    const card = insertRes.rows[0];
    broadcast('card_created', card);
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function renormalizeColumn(columnId) {
  await db.exec('BEGIN');
  try {
    const cardsRes = await db.query(
      `SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC`,
      [columnId]
    );
    
    let pos = 1000;
    for (const card of cardsRes.rows) {
      await db.query(
        `UPDATE cards SET position = $1 WHERE id = $2`,
        [pos, card.id]
      );
      pos += 1000;
    }
    await db.exec('COMMIT');
    
    const updatedCardsRes = await db.query(
      `SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC`,
      [columnId]
    );
    broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;
  
  try {
    await db.exec('BEGIN');
    
    let newPosition;
    
    if (!beforeId && !afterId) {
      const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
      const maxPos = maxPosRes.rows[0].max_pos || 0;
      newPosition = maxPos + 1000;
    } else if (!beforeId) {
      const afterRes = await db.query(`SELECT position FROM cards WHERE id = $1 AND column_id = $2`, [afterId, columnId]);
      if (afterRes.rows.length === 0) {
        const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
        newPosition = (maxPosRes.rows[0].max_pos || 0) + 1000;
      } else {
        newPosition = afterRes.rows[0].position + 1000;
      }
    } else if (!afterId) {
      const beforeRes = await db.query(`SELECT position FROM cards WHERE id = $1 AND column_id = $2`, [beforeId, columnId]);
      if (beforeRes.rows.length === 0) {
        const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
        newPosition = (maxPosRes.rows[0].max_pos || 0) + 1000;
      } else {
        const beforePos = beforeRes.rows[0].position;
        newPosition = beforePos / 2;
        
        if (newPosition === 0 || newPosition === beforePos || beforePos < 0.001) {
          await db.exec('COMMIT');
          await renormalizeColumn(columnId);
          
          await db.exec('BEGIN');
          const beforeRes2 = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
          newPosition = beforeRes2.rows[0].position / 2;
        }
      }
    } else {
      const afterRes = await db.query(`SELECT position FROM cards WHERE id = $1 AND column_id = $2`, [afterId, columnId]);
      const beforeRes = await db.query(`SELECT position FROM cards WHERE id = $1 AND column_id = $2`, [beforeId, columnId]);
      
      if (afterRes.rows.length === 0 || beforeRes.rows.length === 0) {
        const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
        newPosition = (maxPosRes.rows[0].max_pos || 0) + 1000;
      } else {
        const afterPos = afterRes.rows[0].position;
        const beforePos = beforeRes.rows[0].position;
        newPosition = (afterPos + beforePos) / 2;
        
        if (Math.abs(beforePos - afterPos) < 0.001 || newPosition === afterPos || newPosition === beforePos) {
          await db.exec('COMMIT');
          await renormalizeColumn(columnId);
          
          await db.exec('BEGIN');
          const afterRes2 = await db.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
          const beforeRes2 = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
          newPosition = (afterRes2.rows[0].position + beforeRes2.rows[0].position) / 2;
        }
      }
    }
    
    const updateRes = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *`,
      [columnId, newPosition, id]
    );
    
    await db.exec('COMMIT');
    
    const card = updateRes.rows[0];
    broadcast('card_moved', card);
    res.json(card);
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
