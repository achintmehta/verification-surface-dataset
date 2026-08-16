const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// PGLite setup with local disk persistence
const db = new PGlite({ dataDir: './.pglite' });

let sseClients = new Set();

// Initialize database
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
  const { rows } = await db.query('SELECT COUNT(*) as count FROM columns');
  if (rows[0].count === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
      ('col-todo', 'To Do', 1),
      ('col-progress', 'In Progress', 2),
      ('col-done', 'Done', 3);
    `);
  }
}

// Broadcast to all SSE clients
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Get full board state
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
  return columns;
}

// Renormalize positions in a column to avoid precision issues
async function renormalizeColumn(columnId) {
  const cardsRes = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;
  const tx = await db.transaction();
  try {
    for (let i = 0; i < cards.length; i++) {
      await tx.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [i + 1, cards[i].id]
      );
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  // Return updated cards
  const updated = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  return updated.rows;
}

app.use(cors());
app.use(express.json());

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
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Get max position in column
    const maxRes = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = maxRes.rows[0].max_pos + 1;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPos]
    );

    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = cardRes.rows[0];

    broadcast('card-created', { card, columnId });
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

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    // Start transaction for atomicity
    const tx = await db.transaction();

    // Get current card to check old column
    const currentRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentRes.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Card not found' });
    }
    const oldColumnId = currentRes.rows[0].column_id;

    // Compute new position
    let newPosition;
    let needsRenorm = false;

    if (beforeId && afterId) {
      const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (beforeRes.rows.length && afterRes.rows.length) {
        const posBefore = beforeRes.rows[0].position;
        const posAfter = afterRes.rows[0].position;
        newPosition = (posBefore + posAfter) / 2;
        if (Math.abs(posBefore - posAfter) < 1e-9) {
          needsRenorm = true;
        }
      } else {
        newPosition = 1000;
      }
    } else if (beforeId) {
      const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      newPosition = beforeRes.rows.length ? beforeRes.rows[0].position - 1 : 1;
    } else if (afterId) {
      const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      newPosition = afterRes.rows.length ? afterRes.rows[0].position + 1 : 1;
    } else {
      // End of column
      const maxRes = await tx.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      newPosition = maxRes.rows[0].max_pos + 1;
    }

    // Update card
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    await tx.commit();

    // Handle renormalization if needed
    let finalCards = null;
    if (needsRenorm) {
      finalCards = await renormalizeColumn(columnId);
      broadcast('column-renormalized', { columnId, cards: finalCards });
    }

    // Fetch canonical card
    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardRes.rows[0];

    broadcast('card-moved', { card, columnId, oldColumnId });

    res.json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial ping or something
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients.delete(res);
  });
});

async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);