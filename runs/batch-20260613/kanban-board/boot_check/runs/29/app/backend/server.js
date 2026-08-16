import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'kanban.db');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite instance
let db;
let clients = new Set(); // SSE clients

async function initDb() {
  // Ensure directory exists
  const dbDir = dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new PGlite(DB_PATH);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (column_id) REFERENCES columns(id)
    );
  `);

  // Seed default columns if none exist
  const colCount = await db.query('SELECT COUNT(*) as count FROM columns');
  if (colCount.rows[0].count === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
      ('col-todo', 'To Do', 1),
      ('col-progress', 'In Progress', 2),
      ('col-done', 'Done', 3);
    `);
  }
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

async function getBoardState() {
  const columnsRes = await db.query(`
    SELECT id, title, position FROM columns ORDER BY position
  `);
  const columns = columnsRes.rows;

  for (const col of columns) {
    const cardsRes = await db.query(`
      SELECT id, column_id, text, position, created_at 
      FROM cards 
      WHERE column_id = $1 
      ORDER BY position
    `, [col.id]);
    col.cards = cardsRes.rows;
  }

  return { columns };
}

app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Get max position in column
    const maxPosRes = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = (maxPosRes.rows[0].max || 0) + 1000;

    const cardId = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(`
      INSERT INTO cards (id, column_id, text, position) 
      VALUES ($1, $2, $3, $4)
    `, [cardId, columnId, text, newPosition]);

    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardRes.rows[0];

    // Broadcast
    broadcast({
      type: 'card-created',
      card,
      columnId
    });

    res.json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    await db.transaction(async (tx) => {
      // Get current card
      const currentRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (currentRes.rows.length === 0) {
        throw new Error('Card not found');
      }
      const currentCard = currentRes.rows[0];

      // Compute new position
      let newPosition;
      let needsRenormalize = false;

      if (beforeId || afterId) {
        let beforePos = null, afterPos = null;

        if (beforeId) {
          const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
          if (beforeRes.rows.length) beforePos = beforeRes.rows[0].position;
        }
        if (afterId) {
          const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
          if (afterRes.rows.length) afterPos = afterRes.rows[0].position;
        }

        if (beforePos !== null && afterPos !== null) {
          newPosition = (beforePos + afterPos) / 2;
          // Check for collision or precision issues
          if (Math.abs(beforePos - afterPos) < 1e-9) {
            needsRenormalize = true;
          }
        } else if (beforePos !== null) {
          newPosition = beforePos - 1000; // or better average with next, but simple
        } else if (afterPos !== null) {
          newPosition = afterPos + 1000;
        } else {
          newPosition = 1000;
        }
      } else {
        // Append to end
        const maxRes = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = (maxRes.rows[0].max || 0) + 1000;
      }

      // Update card
      await tx.query(`
        UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
      `, [columnId, newPosition, cardId]);

      if (needsRenormalize) {
        await renormalizeColumn(tx, columnId);
      }
    });

    // Fetch updated card
    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    // Broadcast canonical state
    broadcast({
      type: 'card-moved',
      card: updatedCard,
      columnId: updatedCard.column_id
    });

    res.json(updatedCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

async function renormalizeColumn(tx, columnId) {
  const cardsRes = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;

  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }

  // Broadcast renormalized board? For simplicity, client will refetch or we send full
  const board = await getBoardState();
  broadcast({
    type: 'board-renormalized',
    board
  });
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.write('\n'); // initial

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);