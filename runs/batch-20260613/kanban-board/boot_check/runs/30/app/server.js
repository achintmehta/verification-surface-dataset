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

let clients = new Set();

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
      ('col-1', 'To Do', 1),
      ('col-2', 'In Progress', 2),
      ('col-3', 'Done', 3);
    `);
  }
}

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    client.write(message);
  });
}

app.get('/api/board', async (req, res) => {
  try {
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

    res.json({ columns });
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
    const posRes = await db.query(`
      SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1
    `, [columnId]);
    const newPos = posRes.rows[0].max_pos + 1000;

    const cardId = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(`
      INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)
    `, [cardId, columnId, text, newPos]);

    const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardRes.rows[0];

    broadcast({ type: 'card-created', card, columnId });
    res.json(card);
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
      let targetColumn = columnId || currentCard.column_id;

      if (beforeId || afterId) {
        let beforePos = null, afterPos = null;

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
          newPosition = beforePos + 1000;
        } else if (afterPos !== null) {
          newPosition = afterPos - 1000;
        } else {
          newPosition = 1000;
        }
      } else {
        // Move to end
        const maxRes = await tx.query(`
          SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1
        `, [targetColumn]);
        newPosition = maxRes.rows[0].max_pos + 1000;
      }

      // Check for collision or precision issues
      const existingRes = await tx.query(`
        SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3
      `, [targetColumn, newPosition, cardId]);

      if (existingRes.rows.length > 0) {
        // Renormalize the column
        await renormalizeColumn(tx, targetColumn);
        // Recompute position after renormalize
        if (beforeId || afterId) {
          let beforePos = null, afterPos = null;
          if (beforeId) {
            const b = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
            beforePos = b.rows[0]?.position;
          }
          if (afterId) {
            const a = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
            afterPos = a.rows[0]?.position;
          }
          if (beforePos !== null && afterPos !== null) {
            newPosition = (beforePos + afterPos) / 2;
          } else if (beforePos !== null) {
            newPosition = beforePos + 1;
          } else if (afterPos !== null) {
            newPosition = afterPos - 1;
          } else {
            newPosition = 1;
          }
        } else {
          const maxRes = await tx.query(`SELECT COALESCE(MAX(position), 0) + 1 as max_pos FROM cards WHERE column_id = $1`, [targetColumn]);
          newPosition = maxRes.rows[0].max_pos;
        }
      }

      // Update card
      await tx.query(`
        UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
      `, [targetColumn, newPosition, cardId]);
    });

    // Get updated card
    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    broadcast({ type: 'card-moved', card: updatedCard, columnId: updatedCard.column_id });
    res.json(updatedCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

async function renormalizeColumn(tx, columnId) {
  const cardsRes = await tx.query(`
    SELECT id FROM cards WHERE column_id = $1 ORDER BY position
  `, [columnId]);
  const cards = cardsRes.rows;

  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }

  broadcast({ type: 'board-renormalized', columnId });
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);