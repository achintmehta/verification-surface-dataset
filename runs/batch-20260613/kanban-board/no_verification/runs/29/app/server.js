import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup - persists to ./kanban-data
const db = new PGlite('./kanban-data');

// In-memory SSE clients
let sseClients = [];

// Broadcast to all connected clients
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(data);
    } catch (e) {
      // client disconnected
    }
  });
  // Clean up dead clients
  sseClients = sseClients.filter(c => !c.destroyed);
}

// Initialize database
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      column_id INTEGER REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default columns if none exist
  const colCount = await db.query('SELECT COUNT(*) as count FROM columns');
  if (colCount.rows[0].count === 0) {
    await db.exec(`
      INSERT INTO columns (title, position) VALUES 
      ('To Do', 1),
      ('In Progress', 2),
      ('Done', 3);
    `);
  }
}

// Get full board state
app.get('/api/board', async (req, res) => {
  try {
    const columnsRes = await db.query(
      'SELECT * FROM columns ORDER BY position'
    );
    const columns = columnsRes.rows;

    for (const col of columns) {
      const cardsRes = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position',
        [col.id]
      );
      col.cards = cardsRes.rows;
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
    // Get max position in column
    const maxPosRes = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = maxPosRes.rows[0].max_pos + 1000;

    const result = await db.query(
      `INSERT INTO cards (column_id, text, position) 
       VALUES ($1, $2, $3) RETURNING *`,
      [columnId, text, newPos]
    );

    const card = result.rows[0];
    broadcast({ type: 'card-created', card, columnId });

    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// Move card
app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    await db.transaction(async (tx) => {
      // Get current card to know old column
      const currentRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (currentRes.rows.length === 0) throw new Error('Card not found');
      const currentCard = currentRes.rows[0];
      const oldColumnId = currentCard.column_id;

      // Compute new position
      let newPosition;
      let beforePos = null;
      let afterPos = null;

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
      } else if (beforePos !== null) {
        newPosition = beforePos - 1000; // or beforePos / 2 if positive
      } else if (afterPos !== null) {
        newPosition = afterPos + 1000;
      } else {
        // Empty or end of column
        const maxRes = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = maxRes.rows[0].max + 1000;
      }

      // Update card
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Check for position collision or precision issues in target column
      const posCheck = await tx.query(
        `SELECT COUNT(*) as cnt FROM cards 
         WHERE column_id = $1 AND position = $2 AND id != $3`,
        [columnId, newPosition, cardId]
      );

      if (posCheck.rows[0].cnt > 0 || Math.abs(newPosition) > 1e10) {
        // Renormalize the column
        await renormalizeColumn(tx, columnId);
      }
    });

    // Fetch updated card
    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    broadcast({ type: 'card-moved', card: updatedCard, columnId });

    res.json(updatedCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Move failed' });
  }
});

// Renormalize positions in a column to 1000,2000,...
async function renormalizeColumn(tx, columnId) {
  const cardsRes = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;

  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await tx.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [newPos, cards[i].id]
    );
  }

  // Broadcast renormalized state
  const updatedCardsRes = await tx.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  broadcast({
    type: 'column-renormalized',
    columnId,
    cards: updatedCardsRes.rows
  });
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('PGLite data stored in ./kanban-data');
  });
}

start().catch(console.error);