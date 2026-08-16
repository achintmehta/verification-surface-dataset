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

// Initialize PGLite with file system persistence
const db = new PGlite(join(__dirname, '../data/kanban.db'));

// SSE clients
let sseClients = [];

// Broadcast to all SSE clients
function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    client.write(message);
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
  } catch (error) {
    console.error('Error fetching board:', error);
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
    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = (posResult.rows[0].max_pos || 0) + 1000;

    const cardId = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [cardId, columnId, text, newPosition]
    );

    const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardResult.rows[0];

    // Broadcast
    broadcast('card-created', { card, columnId });

    res.status(201).json(card);
  } catch (error) {
    console.error('Error creating card:', error);
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
      const currentResult = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (currentResult.rows.length === 0) {
        throw new Error('Card not found');
      }
      const currentCard = currentResult.rows[0];

      // Remove from old position (if needed, but we'll update)
      // Compute new position
      let newPosition;

      if (beforeId && afterId) {
        // Between two cards
        const beforeResult = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const afterResult = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        
        const beforePos = beforeResult.rows[0]?.position || 0;
        const afterPos = afterResult.rows[0]?.position || 0;
        
        newPosition = (beforePos + afterPos) / 2;
      } else if (beforeId) {
        // Before a card (at beginning or insert before)
        const beforeResult = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const beforePos = beforeResult.rows[0]?.position || 1000;
        newPosition = beforePos - 1; // or better calc
      } else if (afterId) {
        // After a card (at end or insert after)
        const afterResult = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        const afterPos = afterResult.rows[0]?.position || 0;
        newPosition = afterPos + 1;
      } else {
        // End of column
        const maxResult = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = (maxResult.rows[0].max_pos || 0) + 1000;
      }

      // Check for collision or precision issues
      const existingPosResult = await tx.query(
        'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
        [columnId, newPosition, cardId]
      );

      if (existingPosResult.rows.length > 0 || Math.abs(newPosition % 1) < 1e-10) {
        // Renormalize the column
        await renormalizeColumn(tx, columnId);
        
        // Recalculate position after renormalization
        if (beforeId && afterId) {
          const beforeResult = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
          const afterResult = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
          const beforePos = beforeResult.rows[0]?.position || 0;
          const afterPos = afterResult.rows[0]?.position || 0;
          newPosition = (beforePos + afterPos) / 2;
        } else if (afterId) {
          const afterResult = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
          newPosition = (afterResult.rows[0]?.position || 0) + 1000;
        } else {
          const maxResult = await tx.query(
            'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
            [columnId]
          );
          newPosition = (maxResult.rows[0].max_pos || 0) + 1000;
        }
      }

      // Update the card
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Get updated card
      const updatedResult = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      const updatedCard = updatedResult.rows[0];

      return updatedCard;
    });

    // Broadcast after successful transaction
    const finalResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const finalCard = finalResult.rows[0];
    broadcast('card-moved', { card: finalCard, columnId });
    res.json(finalCard);
  } catch (error) {
    console.error('Error moving card:', error);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// Renormalize positions in a column
async function renormalizeColumn(tx, columnId) {
  const cardsResult = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsResult.rows;
  
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await tx.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [newPos, cards[i].id]
    );
  }
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.push(res);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

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