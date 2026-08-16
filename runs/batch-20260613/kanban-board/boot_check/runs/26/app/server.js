import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup - persist to local disk
const DB_PATH = join(__dirname, 'kanban.db');
let db;

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

// SSE clients
const sseClients = new Set();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Helper to compute fractional position
function computePosition(afterPos, beforePos) {
  if (afterPos === null && beforePos === null) {
    return 1.0;
  }
  if (afterPos === null) {
    return beforePos - 1.0;
  }
  if (beforePos === null) {
    return afterPos + 1.0;
  }
  const mid = (afterPos + beforePos) / 2;
  // Check for precision issues
  if (Math.abs(afterPos - beforePos) < 1e-9) {
    return mid; // will trigger renormalize later
  }
  return mid;
}

async function renormalizeColumn(columnId) {
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cardIds = rows.map(r => r.id);
  const updates = cardIds.map((id, idx) => ({
    id,
    position: (idx + 1) * 1000
  }));

  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [u.position, u.id]
      );
    }
  });

  // Fetch updated cards for broadcast
  const updatedCards = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  broadcast({
    type: 'board-renormalized',
    board: await getBoardState()
  });
}

async function getBoardState() {
  const columnsRes = await db.query('SELECT * FROM columns ORDER BY position');
  const columns = columnsRes.rows;

  for (const col of columns) {
    const cardsRes = await db.query(
      'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
      [col.id]
    );
    col.cards = cardsRes.rows;
  }

  return { columns };
}

// Routes

// GET /api/board
app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

// POST /api/cards
app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text required' });
    }

    // Get max position in column
    const posRes = await db.query(
      'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = posRes.rows[0].max_pos || 0;
    const newPos = maxPos + 1000;

    const cardId = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [cardId, columnId, text, newPos]
    );

    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardRes.rows[0];

    const update = { type: 'card-created', card, columnId };
    broadcast(update);

    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PATCH /api/cards/:id/move
app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  try {
    await db.transaction(async (tx) => {
      // Get current card to know old column (for potential renormalize)
      const currentRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (currentRes.rows.length === 0) {
        throw new Error('Card not found');
      }
      const currentCard = currentRes.rows[0];
      const oldColumnId = currentCard.column_id;

      // Get positions of reference cards
      let afterPos = null, beforePos = null;

      if (afterId) {
        const r = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        afterPos = r.rows[0] ? r.rows[0].position : null;
      }
      if (beforeId) {
        const r = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        beforePos = r.rows[0] ? r.rows[0].position : null;
      }

      let newPos = computePosition(afterPos, beforePos);

      // Update card
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPos, cardId]
      );

      // Check for collision/precision exhaustion in target column
      const countRes = await tx.query(
        `SELECT COUNT(*) as cnt FROM cards WHERE column_id = $1 AND ABS(position - $2) < 1e-6`,
        [columnId, newPos]
      );
      const collision = countRes.rows[0].cnt > 1;

      if (collision || Math.abs(newPos) > 1e10) {
        // Renormalize after commit
        // We commit first then renormalize outside
      }
    });

    // Get the updated card
    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    // Broadcast canonical state
    broadcast({ type: 'card-moved', card: updatedCard, columnId });

    // Check if renormalize needed (outside transaction for simplicity)
    const targetCards = await db.query(
      'SELECT position FROM cards WHERE column_id = $1 ORDER BY position',
      [columnId]
    );
    const positions = targetCards.rows.map(r => r.position);
    let needsRenorm = false;
    for (let i = 1; i < positions.length; i++) {
      if (Math.abs(positions[i] - positions[i-1]) < 1e-9 || Math.abs(positions[i]) > 1e12) {
        needsRenorm = true;
        break;
      }
    }
    if (needsRenorm) {
      await renormalizeColumn(columnId);
    }

    res.json(updatedCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// SSE endpoint
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write('\n');

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);