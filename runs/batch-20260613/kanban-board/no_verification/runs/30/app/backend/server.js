import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup - persist to local disk
const db = new PGlite(join(__dirname, '../kanban-data'));

let clients = new Set(); // SSE clients

async function initDb() {
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
  clients.forEach(client => {
    client.write(payload);
  });
}

async function getBoardState() {
  const columnsRes = await db.query(`
    SELECT * FROM columns ORDER BY position
  `);
  const columns = columnsRes.rows;

  for (const col of columns) {
    const cardsRes = await db.query(`
      SELECT * FROM cards WHERE column_id = $1 ORDER BY position
    `, [col.id]);
    col.cards = cardsRes.rows;
  }

  return { columns };
}

async function renormalizeColumn(columnId) {
  const cardsRes = await db.query(`
    SELECT id FROM cards WHERE column_id = $1 ORDER BY position
  `, [columnId]);
  const cards = cardsRes.rows;

  // Assign new positions 1,2,3,...
  for (let i = 0; i < cards.length; i++) {
    await db.query(`
      UPDATE cards SET position = $1 WHERE id = $2
    `, [i + 1, cards[i].id]);
  }

  // Broadcast renormalized
  const board = await getBoardState();
  broadcast({ type: 'board-renormalized', board });
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
    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    // Get max position in column
    const maxPosRes = await db.query(`
      SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1
    `, [columnId]);
    const newPos = (maxPosRes.rows[0].max || 0) + 1;

    await db.query(`
      INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)
    `, [id, columnId, text, newPos]);

    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = cardRes.rows[0];

    broadcast({ type: 'card-created', card, columnId });
    res.status(201).json(card);
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
    await db.exec('BEGIN');

    // Get current card info
    const currentRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const currentCard = currentRes.rows[0];
    const oldColumnId = currentCard.column_id;

    // Compute new position
    let newPosition;
    if (beforeId || afterId) {
      let beforePos = null;
      let afterPos = null;

      if (beforeId) {
        const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        if (beforeRes.rows.length) beforePos = beforeRes.rows[0].position;
      }
      if (afterId) {
        const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        if (afterRes.rows.length) afterPos = afterRes.rows[0].position;
      }

      if (beforePos !== null && afterPos !== null) {
        newPosition = (beforePos + afterPos) / 2;
      } else if (beforePos !== null) {
        newPosition = beforePos - 1;
      } else if (afterPos !== null) {
        newPosition = afterPos + 1;
      } else {
        newPosition = 1;
      }
    } else {
      // Append to end
      const maxRes = await db.query(`
        SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1
      `, [columnId]);
      newPosition = (maxRes.rows[0].max || 0) + 1;
    }

    // Check for collision or precision issues (very close positions)
    const checkRes = await db.query(`
      SELECT COUNT(*) as cnt FROM cards 
      WHERE column_id = $1 AND ABS(position - $2) < 0.0001 AND id != $3
    `, [columnId, newPosition, cardId]);
    
    if (checkRes.rows[0].cnt > 0 || Math.abs(newPosition) > 1e10) {
      // Renormalize first
      await db.exec('COMMIT'); // commit current? better handle inside
      await renormalizeColumn(columnId);
      // Recompute after renormalize
      await db.exec('BEGIN');
      // Simple append after renormalize
      const maxRes2 = await db.query(`
        SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1
      `, [columnId]);
      newPosition = (maxRes2.rows[0].max || 0) + 1;
    }

    // Update the card
    await db.query(`
      UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
    `, [columnId, newPosition, cardId]);

    await db.exec('COMMIT');

    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    broadcast({ type: 'card-moved', card: updatedCard, columnId });
    res.json(updatedCard);
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  clients.add(res);

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  req.on('close', () => {
    clients.delete(res);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('PGLite data persisted to ./kanban-data');
  });
}

start().catch(console.error);
