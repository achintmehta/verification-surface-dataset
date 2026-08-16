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

  const res = await db.query('SELECT count(*) FROM columns');
  if (parseInt(res.rows[0].count) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
      ('col-1', 'To Do', 1000),
      ('col-2', 'In Progress', 2000),
      ('col-3', 'Done', 3000);
    `);
  }
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
  const columnsRes = await db.query('SELECT * FROM columns ORDER BY position ASC');
  const cardsRes = await db.query('SELECT * FROM cards ORDER BY position ASC');
  
  const board = columnsRes.rows.map(col => ({
    ...col,
    cards: cardsRes.rows.filter(card => card.column_id === col.id)
  }));
  
  res.json(board);
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  const id = 'card-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  
  let newCard;
  try {
    await db.transaction(async (tx) => {
      const maxPosRes = await tx.query('SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1', [columnId]);
      const maxPos = maxPosRes.rows[0].max_pos || 0;
      const position = maxPos + 1000;

      await tx.query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
        [id, columnId, text, position]
      );

      const newCardRes = await tx.query('SELECT * FROM cards WHERE id = $1', [id]);
      newCard = newCardRes.rows[0];
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  broadcast('card_created', newCard);
  res.json(newCard);
});

async function renormalize(columnId) {
  let updatedCards;
  await db.transaction(async (tx) => {
    const cardsRes = await tx.query('SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
    let pos = 1000;
    for (const card of cardsRes.rows) {
      await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
      pos += 1000;
    }
    const updatedCardsRes = await tx.query('SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
    updatedCards = updatedCardsRes.rows;
  });
  broadcast('column_renormalized', { columnId, cards: updatedCards });
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;

  let updatedCard;
  let needsRenormalization = false;

  try {
    await db.transaction(async (tx) => {
      let newPosition;

      if (!beforeId && !afterId) {
        newPosition = 1000;
      } else if (!beforeId) {
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        if (afterRes.rows.length === 0) throw new Error('afterId not found');
        newPosition = afterRes.rows[0].position + 1000;
      } else if (!afterId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        if (beforeRes.rows.length === 0) throw new Error('beforeId not found');
        newPosition = beforeRes.rows[0].position / 2;
      } else {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        if (beforeRes.rows.length === 0 || afterRes.rows.length === 0) throw new Error('beforeId or afterId not found');
        newPosition = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
      }

      await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [columnId, newPosition, id]);

      const updatedCardRes = await tx.query('SELECT * FROM cards WHERE id = $1', [id]);
      updatedCard = updatedCardRes.rows[0];

      const cardsRes = await tx.query('SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC', [columnId]);
      for (let i = 0; i < cardsRes.rows.length - 1; i++) {
        if (cardsRes.rows[i+1].position - cardsRes.rows[i].position < 0.001) {
          needsRenormalization = true;
          break;
        }
      }
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  broadcast('card_moved', updatedCard);
  res.json(updatedCard);

  if (needsRenormalization) {
    await renormalize(columnId);
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
  });
});
