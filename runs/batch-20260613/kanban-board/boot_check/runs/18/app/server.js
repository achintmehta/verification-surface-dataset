import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./db');

let sseClients = [];

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.res.write(message));
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
  sseClients.push(client);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
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
  const { columnId, text } = req.body;
  try {
    const insertRes = await db.query(`
      INSERT INTO cards (column_id, text, position)
      VALUES ($1, $2, COALESCE((SELECT MAX(position) FROM cards WHERE column_id = $1), 0) + 1000)
      RETURNING *
    `, [columnId, text]);
    const newCard = insertRes.rows[0];
    
    broadcast('card_created', newCard);
    res.json(newCard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function renormalizeColumn(columnId) {
  await db.query('BEGIN');
  try {
    const cardsRes = await db.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
    let pos = 1000;
    for (const card of cardsRes.rows) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
      pos += 1000;
    }
    await db.query('COMMIT');
    const updatedCards = await db.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
    broadcast('column_renormalized', { columnId, cards: updatedCards.rows });
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;

  try {
    let newPos;
    
    if (!beforeId && !afterId) {
      // Empty column
      newPos = 1000;
    } else if (!beforeId) {
      // Move to end
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (afterRes.rows.length === 0) throw new Error('afterId not found');
      newPos = afterRes.rows[0].position + 1000;
    } else if (!afterId) {
      // Move to start
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (beforeRes.rows.length === 0) throw new Error('beforeId not found');
      newPos = beforeRes.rows[0].position / 2;
    } else {
      // Move between
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (beforeRes.rows.length === 0 || afterRes.rows.length === 0) throw new Error('beforeId or afterId not found');
      newPos = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
    }

    const updateRes = await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *',
      [columnId, newPos, cardId]
    );
    const updatedCard = updateRes.rows[0];

    broadcast('card_moved', updatedCard);
    res.json(updatedCard);

    // Check for precision issues or collisions
    // If newPos is too close to existing positions, renormalize
    if (beforeId && afterId) {
      const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (beforeRes.rows.length > 0 && afterRes.rows.length > 0) {
        if (Math.abs(beforeRes.rows[0].position - afterRes.rows[0].position) < 0.001) {
          await renormalizeColumn(columnId);
        }
      }
    } else if (!afterId && beforeId) {
      if (newPos < 0.001) {
        await renormalizeColumn(columnId);
      }
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
