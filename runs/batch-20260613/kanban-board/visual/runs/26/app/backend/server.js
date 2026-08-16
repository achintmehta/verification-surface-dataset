const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup - persist to local disk
const db = new PGlite('./backend/pglite-data');

// SSE clients
let sseClients = [];

// Broadcast function
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client, index) => {
    try {
      client.res.write(payload);
    } catch (err) {
      sseClients.splice(index, 1);
    }
  });
}

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

// Get board state
app.get('/api/board', async (req, res) => {
  try {
    const columns = await db.query(`
      SELECT * FROM columns ORDER BY position
    `);
    const cards = await db.query(`
      SELECT * FROM cards ORDER BY column_id, position
    `);

    const board = columns.rows.map(col => ({
      ...col,
      cards: cards.rows.filter(card => card.column_id === col.id)
    }));

    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

// Create card
app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Get max position in column
    const maxPosRes = await db.query(
      'SELECT COALESCE(MAX(position), 0) as maxPos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = (maxPosRes.rows[0].maxPos || 0) + 1000;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPos]
    );

    const newCard = { id, column_id: columnId, text, position: newPos };
    broadcast('card-created', { card: newCard });
    res.status(201).json(newCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// Move card
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
      if (beforeId && afterId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        const beforePos = beforeRes.rows[0]?.position || 0;
        const afterPos = afterRes.rows[0]?.position || 1000;
        newPosition = (beforePos + afterPos) / 2;
      } else if (beforeId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        newPosition = (beforeRes.rows[0]?.position || 1000) - 0.5; // or better calc
      } else if (afterId) {
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        newPosition = (afterRes.rows[0]?.position || 0) + 0.5;
      } else {
        // End of column
        const maxRes = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as maxPos FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = (maxRes.rows[0].maxPos || 0) + 1000;
      }

      // Check for collision/precision issues
      const existingPosRes = await tx.query(
        'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
        [columnId, newPosition, cardId]
      );
      if (existingPosRes.rows.length > 0) {
        // Renormalize column
        await renormalizeColumn(tx, columnId);
        // Recompute position after renormalize
        if (beforeId && afterId) {
          const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
          const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
          const beforePos = beforeRes.rows[0]?.position || 1000;
          const afterPos = afterRes.rows[0]?.position || 2000;
          newPosition = (beforePos + afterPos) / 2;
        } else {
          const maxRes = await tx.query(
            'SELECT COALESCE(MAX(position), 0) as maxPos FROM cards WHERE column_id = $1',
            [columnId]
          );
          newPosition = (maxRes.rows[0].maxPos || 0) + 1000;
        }
      }

      // Update card
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Return updated card
      const updatedRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      const updatedCard = updatedRes.rows[0];

      // Broadcast after commit
      broadcast('card-moved', { card: updatedCard, columnId });
      res.json(updatedCard);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// Renormalize positions in a column to avoid precision loss
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
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push({ res });

  req.on('close', () => {
    sseClients = sseClients.filter(client => client.res !== res);
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