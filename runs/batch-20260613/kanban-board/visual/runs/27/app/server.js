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

// PGLite setup - persist to local disk
const db = new PGlite(join(__dirname, 'kanban.db'));

let clients = new Set(); // SSE clients

async function initDB() {
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
      ('col-1', 'To Do', 1.0),
      ('col-2', 'In Progress', 2.0),
      ('col-3', 'Done', 3.0);
    `);
  }
}

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    client.write(message);
  });
}

async function getBoardState() {
  const columnsRes = await db.query(`
    SELECT * FROM columns ORDER BY position
  `);
  const columns = columnsRes.rows;

  for (const col of columns) {
    const cardsRes = await db.query(`
      SELECT * FROM cards WHERE column_id = $1 ORDER BY position
    `, [col.id]);
    col.cards = cardsRes.rows;
  }

  return { columns };
}

app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Get max position in column
    const posRes = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = (posRes.rows[0].max_pos || 0) + 1000;

    const cardId = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)`,
      [cardId, columnId, text, newPos]
    );

    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardRes.rows[0];

    broadcast({ type: 'card-created', card, columnId });
    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

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
      } else if (afterId) {
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        newPosition = (afterRes.rows[0]?.position || 0) + 1000;
      } else if (beforeId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        newPosition = (beforeRes.rows[0]?.position || 1000) - 1000;
      } else {
        // Append to end
        const maxRes = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
          [columnId]
        );
        newPosition = (maxRes.rows[0].max_pos || 0) + 1000;
      }

      // Check for collision / precision issues
      const existingRes = await tx.query(
        'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
        [columnId, newPosition, cardId]
      );

      if (existingRes.rows.length > 0 || Math.abs(newPosition) > 1e10) {
        // Renormalize the column
        const allCardsRes = await tx.query(
          'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
          [columnId]
        );
        const cardIds = allCardsRes.rows.map(r => r.id);
        
        // Exclude current if moving within
        let insertIndex = cardIds.length;
        if (currentCard.column_id === columnId) {
          const currIdx = cardIds.indexOf(cardId);
          if (currIdx !== -1) cardIds.splice(currIdx, 1);
        }

        // Determine insert pos
        if (afterId) {
          insertIndex = cardIds.indexOf(afterId) + 1;
        } else if (beforeId) {
          insertIndex = cardIds.indexOf(beforeId);
        }

        cardIds.splice(insertIndex, 0, cardId);

        // Reassign positions
        for (let i = 0; i < cardIds.length; i++) {
          await tx.query(
            'UPDATE cards SET position = $1, column_id = $2 WHERE id = $3',
            [(i + 1) * 1000, columnId, cardIds[i]]
          );
        }

        broadcast({ type: 'board-renormalized', columnId });
      } else {
        // Normal update
        await tx.query(
          'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
          [columnId, newPosition, cardId]
        );
      }
    });

    // Get updated card
    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    broadcast({ type: 'card-moved', card: updatedCard, columnId });
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

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('PGLite database initialized at kanban.db');
  });
}

start().catch(console.error);