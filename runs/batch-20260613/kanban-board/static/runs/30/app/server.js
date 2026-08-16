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
const db = new PGlite(join(__dirname, 'kanban-data'));

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

// Initialize DB and start server
async function startServer() {
  await initDb();
  console.log('Database initialized');

  // GET /api/board - return all columns with ordered cards
  app.get('/api/board', async (req, res) => {
    try {
      const { rows: columns } = await db.query(
        'SELECT * FROM columns ORDER BY position'
      );
      
      const result = [];
      for (const col of columns) {
        const { rows: cards } = await db.query(
          'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
          [col.id]
        );
        result.push({ ...col, cards });
      }
      
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch board' });
    }
  });

  // POST /api/cards - create card at end of column
  app.post('/api/cards', async (req, res) => {
    try {
      const { columnId, text } = req.body;
      if (!columnId || !text) {
        return res.status(400).json({ error: 'columnId and text required' });
      }

      // Find max position in column
      const { rows: maxPosRows } = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      const newPosition = maxPosRows[0].max_pos + 1000;

      const cardId = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      
      await db.query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
        [cardId, columnId, text, newPosition]
      );

      const { rows: [newCard] } = await db.query(
        'SELECT * FROM cards WHERE id = $1',
        [cardId]
      );

      const result = { ...newCard, columnId: newCard.column_id };
      broadcast('card-created', result);
      res.status(201).json(result);
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
        // Get current card
        const { rows: [currentCard] } = await tx.query(
          'SELECT * FROM cards WHERE id = $1',
          [cardId]
        );
        if (!currentCard) {
          throw new Error('Card not found');
        }

        const oldColumnId = currentCard.column_id;
        const newColumnId = columnId || oldColumnId;

        // Compute new position
        let newPosition;
        if (beforeId && afterId) {
          const { rows: beforeRows } = await tx.query(
            'SELECT position FROM cards WHERE id = $1',
            [beforeId]
          );
          const { rows: afterRows } = await tx.query(
            'SELECT position FROM cards WHERE id = $1',
            [afterId]
          );
          const beforePos = beforeRows[0]?.position || 0;
          const afterPos = afterRows[0]?.position || 0;
          newPosition = (beforePos + afterPos) / 2;
        } else if (beforeId) {
          const { rows: beforeRows } = await tx.query(
            'SELECT position FROM cards WHERE id = $1',
            [beforeId]
          );
          newPosition = beforeRows[0].position + 1000;
        } else if (afterId) {
          const { rows: afterRows } = await tx.query(
            'SELECT position FROM cards WHERE id = $1',
            [afterId]
          );
          newPosition = afterRows[0].position - 1000;
        } else {
          // End of column
          const { rows: maxRows } = await tx.query(
            'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
            [newColumnId]
          );
          newPosition = maxRows[0].max_pos + 1000;
        }

        // Check for collision or precision issues
        const { rows: collisionCheck } = await tx.query(
          'SELECT COUNT(*) as count FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
          [newColumnId, newPosition, cardId]
        );
        
        if (collisionCheck[0].count > 0 || Math.abs(newPosition) > 1e10) {
          // Renormalize the column
          const { rows: allCards } = await tx.query(
            'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
            [newColumnId]
          );
          for (let i = 0; i < allCards.length; i++) {
            await tx.query(
              'UPDATE cards SET position = $1 WHERE id = $2',
              [(i + 1) * 1000, allCards[i].id]
            );
          }
          // Recalculate new position
          if (beforeId && afterId) {
            const { rows: beforeRows } = await tx.query(
              'SELECT position FROM cards WHERE id = $1',
              [beforeId]
            );
            const { rows: afterRows } = await tx.query(
              'SELECT position FROM cards WHERE id = $1',
              [afterId]
            );
            newPosition = (beforeRows[0].position + afterRows[0].position) / 2;
          } else {
            newPosition = (allCards.length + 1) * 1000;
          }
        }

        // Update the card
        await tx.query(
          'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
          [newColumnId, newPosition, cardId]
        );

        // Fetch updated card
        const { rows: [updatedCard] } = await tx.query(
          'SELECT * FROM cards WHERE id = $1',
          [cardId]
        );

        const result = { 
          ...updatedCard, 
          columnId: updatedCard.column_id,
          oldColumnId 
        };
        
        // Broadcast after commit
        broadcast('card-moved', result);
        res.json(result);
      });
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
    res.setHeader('Access-Control-Allow-Origin', '*');

    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });

    // Send initial ping
    res.write('event: connected\ndata: {}\n\n');
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);