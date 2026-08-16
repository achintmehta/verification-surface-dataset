const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup with file persistence
const dataDir = path.join(__dirname, '.pglite');
const db = new PGlite({ dataDir });

// SSE clients
let sseClients = [];

// Broadcast function
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    client.write(payload);
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
      cards: cards.rows
        .filter(card => card.column_id === col.id)
        .sort((a, b) => a.position - b.position)
    }));

    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create card
app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Find max position in column
    const maxPos = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = (maxPos.rows[0].max || 0) + 1000;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPos]
    );

    const newCard = { id, column_id: columnId, text, position: newPos };
    broadcast('card-created', { card: newCard });
    res.status(201).json(newCard);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      const current = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (current.rows.length === 0) {
        throw new Error('Card not found');
      }

      // Compute new position
      let newPosition;
      if (beforeId && afterId) {
        const before = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const after = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        if (before.rows.length && after.rows.length) {
          newPosition = (before.rows[0].position + after.rows[0].position) / 2;
        } else {
          newPosition = 1000;
        }
      } else if (beforeId) {
        const before = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        newPosition = before.rows.length ? before.rows[0].position - 1000 : 1000;
      } else if (afterId) {
        const after = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        newPosition = after.rows.length ? after.rows[0].position + 1000 : 1000;
      } else {
        // End of column
        const maxPos = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = (maxPos.rows[0].max || 0) + 1000;
      }

      // Check for collision or precision issues (simple renormalization)
      const positions = await tx.query(
        'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position',
        [columnId]
      );
      const posList = positions.rows.map(r => r.position);
      const hasCollision = new Set(posList).size !== posList.length;
      const minPos = Math.min(...posList, newPosition);
      const maxPos = Math.max(...posList, newPosition);
      const needsRenorm = hasCollision || (maxPos - minPos > 100000); // arbitrary threshold

      if (needsRenorm) {
        // Renormalize positions in this column
        const allCards = await tx.query(
          'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
          [columnId]
        );
        for (let i = 0; i < allCards.rows.length; i++) {
          await tx.query(
            'UPDATE cards SET position = $1 WHERE id = $2',
            [(i + 1) * 1000, allCards.rows[i].id]
          );
        }
        // Recalculate newPosition after renorm
        if (beforeId && afterId) {
          const before = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
          const after = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
          newPosition = (before.rows[0].position + after.rows[0].position) / 2;
        } else {
          newPosition = (allCards.rows.length + 1) * 1000;
        }
      }

      // Update the card
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Get updated card
      const updated = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      const canonicalCard = updated.rows[0];

      // Broadcast after commit
      broadcast('card-moved', { card: canonicalCard, columnId });
      res.json(canonicalCard);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
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