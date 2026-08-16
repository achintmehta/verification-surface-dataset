import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

let clients = [];

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

  const res = await db.query(`SELECT count(*) FROM columns`);
  if (parseInt(res.rows[0].count) === 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES
      ('To Do', 1000),
      ('In Progress', 2000),
      ('Done', 3000);
    `);
  }
}

initDb().catch(console.error);

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
    const columnsRes = await db.query(`SELECT * FROM columns ORDER BY position ASC`);
    const cardsRes = await db.query(`SELECT * FROM cards ORDER BY position ASC`);
    
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
    const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
    const maxPos = maxPosRes.rows[0].max_pos || 0;
    const newPos = maxPos + 1000;

    const insertRes = await db.query(
      `INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING *`,
      [columnId, text, newPos]
    );
    const newCard = insertRes.rows[0];
    
    broadcast('card_created', newCard);
    res.json(newCard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function renormalize(columnId) {
  await db.query('BEGIN');
  try {
    const cardsRes = await db.query(`SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
    let pos = 1000;
    for (const card of cardsRes.rows) {
      await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [pos, card.id]);
      pos += 1000;
    }
    await db.query('COMMIT');
    const updatedCards = await db.query(`SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
    broadcast('column_renormalized', { columnId, cards: updatedCards.rows });
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, prevId, nextId } = req.body;
  
  try {
    let newPos;
    let prevPos = null;
    let nextPos = null;
    
    if (prevId) {
      const prevRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [prevId]);
      if (prevRes.rows.length > 0) prevPos = prevRes.rows[0].position;
    }
    if (nextId) {
      const nextRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [nextId]);
      if (nextRes.rows.length > 0) nextPos = nextRes.rows[0].position;
    }
    
    if (prevPos === null && nextPos === null) {
      newPos = 1000;
    } else if (prevPos === null) {
      newPos = nextPos / 2;
    } else if (nextPos === null) {
      newPos = prevPos + 1000;
    } else {
      newPos = (prevPos + nextPos) / 2;
    }

    const updateRes = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *`,
      [columnId, newPos, cardId]
    );
    
    const updatedCard = updateRes.rows[0];
    broadcast('card_moved', updatedCard);
    res.json(updatedCard);

    if (prevPos !== null && nextPos !== null && (nextPos - prevPos) < 0.001) {
      await renormalize(columnId);
    } else if (prevPos === null && nextPos !== null && newPos < 0.001) {
      await renormalize(columnId);
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
