import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize PGLite with file system persistence
const db = new PGlite(join(__dirname, 'kanban.db'));

// Database initialization
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
  const { rows: existingColumns } = await db.query('SELECT COUNT(*) as count FROM columns');
  if (existingColumns[0].count === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES 
      ('col-todo', 'To Do', 1),
      ('col-progress', 'In Progress', 2),
      ('col-done', 'Done', 3);
    `);
  }
}

// SSE clients
let sseClients = new Set();

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// Helper to compute new position
async function computeNewPosition(columnId, beforeId, afterId) {
  let beforePos = null;
  let afterPos = null;

  if (beforeId) {
    const { rows } = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [beforeId, columnId]
    );
    if (rows.length > 0) beforePos = rows[0].position;
  }

  if (afterId) {
    const { rows } = await db.query(
      'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
      [afterId, columnId]
    );
    if (rows.length > 0) afterPos = rows[0].position;
  }

  let newPos;
  if (beforePos !== null && afterPos !== null) {
    newPos = (beforePos + afterPos) / 2;
  } else if (beforePos !== null) {
    newPos = beforePos + 1;
  } else if (afterPos !== null) {
    newPos = afterPos - 1;
  } else {
    // Empty column or end
    const { rows } = await db.query(
      'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    newPos = (rows[0].max_pos || 0) + 1;
  }

  // Check for collision or precision issues
  if (beforePos !== null && afterPos !== null && Math.abs(newPos - beforePos) < 1e-10) {
    await renormalizeColumn(columnId);
    // Recompute after renormalization
    return await computeNewPosition(columnId, beforeId, afterId);
  }

  return newPos;
}

async function renormalizeColumn(columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  
  for (let i = 0; i < cards.length; i++) {
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [i + 1, cards[i].id]
    );
  }
  
  // Broadcast renormalized state
  const board = await getBoardState();
  broadcast('board-update', board);
}

// Get full board state
async function getBoardState() {
  const { rows: columns } = await db.query(
    'SELECT * FROM columns ORDER BY position'
  );
  
  for (const column of columns) {
    const { rows: cards } = await db.query(
      'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
      [column.id]
    );
    column.cards = cards;
  }
  
  return { columns };
}

// API Routes

// Get board state
app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

// Create card
app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text required' });
    }

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    // Get max position in column
    const { rows } = await db.query(
      'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const position = (rows[0].max_pos || 0) + 1;

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, position]
    );

    const { rows: newCardRows } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const newCard = newCardRows[0];

    // Broadcast
    broadcast('card-created', { card: newCard, columnId });

    res.status(201).json(newCard);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// Move card
app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId, afterId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId required' });
    }

    // Start transaction-like operation (PGLite is single connection, but we do sequential)
    // First, get current card to know old column
    const { rows: currentCardRows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentCardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }
    const currentCard = currentCardRows[0];
    const oldColumnId = currentCard.column_id;

    // Compute new position
    let newPosition = await computeNewPosition(columnId, beforeId, afterId);

    // Update atomically
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    // Get updated card
    const { rows: updatedCardRows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedCardRows[0];

    // Broadcast the move
    broadcast('card-moved', {
      card: updatedCard,
      fromColumnId: oldColumnId,
      toColumnId: columnId
    });

    res.json(updatedCard);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.add(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Initialize and start server
async function start() {
  await initDb();
  console.log('Database initialized');

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);