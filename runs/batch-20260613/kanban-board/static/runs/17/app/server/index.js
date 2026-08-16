import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const dbDir = path.join(__dirname, '../db-data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new PGlite(dbDir);

let clients = [];

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
  if (parseInt(res.rows[0].count) === 0) {
    await db.query(`INSERT INTO columns (id, title, position) VALUES 
      ('col-1', 'To Do', 1000),
      ('col-2', 'In Progress', 2000),
      ('col-3', 'Done', 3000)
    `);
  }
}

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

  const clientId = uuidv4();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on('close', () => {
    clients = clients.filter(client => client.id !== clientId);
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
  const { text, columnId } = req.body;
  const id = uuidv4();
  
  const maxPosRes = await db.query(`SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1`, [columnId]);
  const maxPos = maxPosRes.rows[0].max_pos || 0;
  const position = maxPos + 1000;

  await db.query(
    `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)`,
    [id, columnId, text, position]
  );

  const newCardRes = await db.query(`SELECT * FROM cards WHERE id = $1`, [id]);
  const newCard = newCardRes.rows[0];

  broadcast('card_created', newCard);
  res.json(newCard);
});

async function renormalizeColumn(columnId) {
  const cardsRes = await db.query(`SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
  let pos = 1000;
  for (const card of cardsRes.rows) {
    await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [pos, card.id]);
    pos += 1000;
  }
  const updatedCardsRes = await db.query(`SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
  broadcast('column_renormalized', { columnId, cards: updatedCardsRes.rows });
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;

  try {
    await db.query('BEGIN');

    let newPosition;
    if (!beforeId && !afterId) {
      newPosition = 1000;
    } else if (!beforeId) {
      const afterRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
      if (afterRes.rows.length > 0) {
        newPosition = afterRes.rows[0].position + 1000;
      } else {
        newPosition = 1000;
      }
    } else if (!afterId) {
      const beforeRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
      if (beforeRes.rows.length > 0) {
        newPosition = beforeRes.rows[0].position / 2;
      } else {
        newPosition = 1000;
      }
    } else {
      const beforeRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
      const afterRes = await db.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
      if (beforeRes.rows.length > 0 && afterRes.rows.length > 0) {
        newPosition = (beforeRes.rows[0].position + afterRes.rows[0].position) / 2;
      } else {
        newPosition = 1000;
      }
    }

    await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
      [columnId, newPosition, id]
    );

    const updatedCardRes = await db.query(`SELECT * FROM cards WHERE id = $1`, [id]);
    const updatedCard = updatedCardRes.rows[0];

    await db.query('COMMIT');

    broadcast('card_moved', updatedCard);
    res.json(updatedCard);

    const cardsRes = await db.query(`SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC`, [columnId]);
    let needsRenormalization = false;
    if (cardsRes.rows.length > 0 && cardsRes.rows[0].position < 0.001) {
      needsRenormalization = true;
    }
    for (let i = 1; i < cardsRes.rows.length; i++) {
      if (cardsRes.rows[i].position - cardsRes.rows[i-1].position < 0.001) {
        needsRenormalization = true;
        break;
      }
    }
    if (needsRenormalization) {
      await renormalizeColumn(columnId);
    }

  } catch (e) {
    await db.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
});
