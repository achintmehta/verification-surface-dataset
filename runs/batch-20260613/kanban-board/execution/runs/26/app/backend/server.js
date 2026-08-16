const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// PGLite instance with file persistence
const db = new PGlite('./.pglite');

// SSE clients
let sseClients = new Set();

// Middleware
app.use(cors());
app.use(express.json());

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
      column_id TEXT NOT NULL REFERENCES columns(id),
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default columns if none exist
  const { rows } = await db.query('SELECT COUNT(*) as count FROM columns');
  if (parseInt(rows[0].count) === 0) {
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
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// Get board state
app.get('/api/board', async (req, res) => {
  try {
    const columnsResult = await db.query(
      'SELECT * FROM columns ORDER BY position'
    );
    const columns = columnsResult.rows;

    for (const column of columns) {
      const cardsResult = await db.query(
        'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
        [column.id]
      );
      column.cards = cardsResult.rows;
    }

    res.json({ columns });
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
    // Find max position in column
    const maxPosResult = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = parseFloat(maxPosResult.rows[0].max_pos) + 1;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPosition]
    );

    const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = cardResult.rows[0];

    broadcast('card-created', { card, columnId });
    res.status(201).json(card);
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
    await db.exec('BEGIN');

    // Get current card to check old column
    const currentCardResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentCardResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const oldColumnId = currentCardResult.rows[0].column_id;

    // Get before and after cards for position calculation
    let beforePos = null, afterPos = null;

    if (beforeId) {
      const beforeResult = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (beforeResult.rows.length > 0) beforePos = parseFloat(beforeResult.rows[0].position);
    }
    if (afterId) {
      const afterResult = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (afterResult.rows.length > 0) afterPos = parseFloat(afterResult.rows[0].position);
    }

    let newPosition;
    if (beforePos !== null && afterPos !== null) {
      newPosition = (beforePos + afterPos) / 2;
    } else if (beforePos !== null) {
      newPosition = beforePos + 1;
    } else if (afterPos !== null) {
      newPosition = afterPos - 1;
    } else {
      // End of column
      const maxPosResult = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      newPosition = parseFloat(maxPosResult.rows[0].max_pos) + 1;
    }

    // Check for collision or precision issues (very close positions)
    const collisionCheck = await db.query(
      'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
      [columnId, newPosition, cardId]
    );

    if (collisionCheck.rows.length > 0 || Math.abs(newPosition % 1) < 1e-10) {
      // Renormalize the column
      await renormalizeColumn(columnId, db);
      // Recalculate new position after renormalize
      if (beforeId) {
        const beforeResult = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        beforePos = beforeResult.rows.length > 0 ? parseFloat(beforeResult.rows[0].position) : null;
      }
      if (afterId) {
        const afterResult = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        afterPos = afterResult.rows.length > 0 ? parseFloat(afterResult.rows[0].position) : null;
      }
      if (beforePos !== null && afterPos !== null) {
        newPosition = (beforePos + afterPos) / 2;
      } else if (beforePos !== null) {
        newPosition = beforePos + 1;
      } else if (afterPos !== null) {
        newPosition = afterPos - 1;
      } else {
        const maxPosResult = await db.query(
          'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = parseFloat(maxPosResult.rows[0].max_pos) + 1;
      }
    }

    // Update card
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    await db.exec('COMMIT');

    const updatedCardResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedCardResult.rows[0];

    broadcast('card-moved', { card: updatedCard, columnId, oldColumnId });
    res.json(updatedCard);
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// Renormalize positions in a column to 1,2,3,...
async function renormalizeColumn(columnId, dbInstance) {
  const cardsResult = await dbInstance.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsResult.rows;

  for (let i = 0; i < cards.length; i++) {
    await dbInstance.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [i + 1, cards[i].id]
    );
  }
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  sseClients.add(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

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