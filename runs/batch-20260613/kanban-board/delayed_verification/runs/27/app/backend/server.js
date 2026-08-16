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

// PGLite initialization with file system persistence
const db = new PGlite(join(__dirname, 'kanban-data'));

// SSE clients
let sseClients = [];

// Broadcast function
function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (e) {}
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
      SELECT c.id, c.title, c.position,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', ca.id,
                   'text', ca.text,
                   'position', ca.position,
                   'column_id', ca.column_id
                 ) ORDER BY ca.position
               ) FILTER (WHERE ca.id IS NOT NULL),
               '[]'
             ) as cards
      FROM columns c
      LEFT JOIN cards ca ON c.id = ca.column_id
      GROUP BY c.id, c.title, c.position
      ORDER BY c.position
    `);
    
    res.json(columns.rows);
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
    const maxPos = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = (maxPos.rows[0].max || 0) + 1000;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPosition]
    );

    const card = { id, column_id: columnId, text, position: newPosition };
    broadcast('card-created', { card });
    res.json(card);
  } catch (error) {
    console.error('Error creating card:', error);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// Move card - server authoritative
app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    const updatedCard = await db.transaction(async (tx) => {
      // Get current card to check old column for possible renormalize later if needed
      const currentRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (currentRes.rows.length === 0) {
        throw new Error('Card not found');
      }

      // Determine new position
      let beforePos = null;
      let afterPos = null;

      if (beforeId) {
        const bRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        if (bRes.rows.length > 0) beforePos = bRes.rows[0].position;
      }
      if (afterId) {
        const aRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        if (aRes.rows.length > 0) afterPos = aRes.rows[0].position;
      }

      let newPosition;
      if (afterPos !== null && beforePos !== null) {
        newPosition = (afterPos + beforePos) / 2;
      } else if (afterPos !== null) {
        newPosition = afterPos + 1000;
      } else if (beforePos !== null) {
        newPosition = beforePos - 1000;
      } else {
        // Append to end of target column
        const maxRes = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = (maxRes.rows[0].max || 0) + 1000;
      }

      // Check for collision or precision issues (very close positions)
      const existingAtPos = await tx.query(
        'SELECT id FROM cards WHERE column_id = $1 AND ABS(position - $2) < 0.0001 AND id != $3',
        [columnId, newPosition, cardId]
      );

      if (existingAtPos.rows.length > 0 || (afterPos !== null && beforePos !== null && Math.abs(afterPos - beforePos) < 0.001)) {
        // Renormalize the target column
        await renormalizeColumn(tx, columnId);
        
        // Recalculate position after renormalization
        if (afterId && beforeId) {
          const aRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
          const bRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
          afterPos = aRes.rows[0]?.position;
          beforePos = bRes.rows[0]?.position;
          if (afterPos !== null && beforePos !== null) {
            newPosition = (afterPos + beforePos) / 2;
          } else {
            const maxRes = await tx.query('SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1', [columnId]);
            newPosition = (maxRes.rows[0].max || 0) + 1000;
          }
        } else if (afterId) {
          const aRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
          newPosition = (aRes.rows[0]?.position || 0) + 1000;
        } else if (beforeId) {
          const bRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
          newPosition = (bRes.rows[0]?.position || 1000) - 1000;
        } else {
          const maxRes = await tx.query('SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1', [columnId]);
          newPosition = (maxRes.rows[0].max || 0) + 1000;
        }
      }

      // Perform the update atomically
      await tx.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      const updated = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
      return updated.rows[0];
    });

    broadcast('card-moved', { card: updatedCard });
    res.json(updatedCard);
  } catch (error) {
    console.error('Error moving card:', error);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

async function renormalizeColumn(tx, columnId) {
  const cardsRes = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  let pos = 1000;
  for (const row of cardsRes.rows) {
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, row.id]);
    pos += 1000;
  }
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });

  res.write('event: connected\ndata: {}\n\n');
});

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);