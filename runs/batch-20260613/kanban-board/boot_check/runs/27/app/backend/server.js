import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Initialize PGlite with file system persistence
const db = new PGlite('./kanban-data');

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
      ('col-todo', 'To Do', 1),
      ('col-progress', 'In Progress', 2),
      ('col-done', 'Done', 3);
    `);
  }
}

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

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

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  try {
    // Find max position in column
    const maxPosResult = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = (maxPosResult.rows[0].max || 0) + 1000;

    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPosition]
    );

    const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = cardResult.rows[0];

    broadcast('card-created', { card, columnId });
    res.json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

async function computeNewPosition(columnId, beforeId, afterId) {
  let beforePos = 0;
  let afterPos = 10000;

  if (afterId) {
    const afterResult = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
    if (afterResult.rows.length > 0) afterPos = afterResult.rows[0].position;
  }
  if (beforeId) {
    const beforeResult = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
    if (beforeResult.rows.length > 0) beforePos = beforeResult.rows[0].position;
  }

  let newPos = (beforePos + afterPos) / 2;

  // Check for collision or precision issues
  const existing = await db.query(
    'SELECT COUNT(*) as count FROM cards WHERE column_id = $1 AND position = $2',
    [columnId, newPos]
  );
  if (existing.rows[0].count > 0 || Math.abs(beforePos - afterPos) < 0.0001) {
    // Renormalize the column
    await renormalizeColumn(columnId);
    // Recompute
    if (afterId) {
      const afterResult = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      afterPos = afterResult.rows[0] ? afterResult.rows[0].position : 10000;
    }
    if (beforeId) {
      const beforeResult = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      beforePos = beforeResult.rows[0] ? beforeResult.rows[0].position : 0;
    }
    newPos = (beforePos + afterPos) / 2;
  }

  return newPos;
}

async function renormalizeColumn(columnId) {
  const cardsResult = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsResult.rows;
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }
  // Broadcast updated order? But caller will handle
}

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }

  try {
    await db.exec('BEGIN');

    // Get current card to know old column
    const currentResult = await db.query('SELECT column_id FROM cards WHERE id = $1', [cardId]);
    if (currentResult.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const oldColumnId = currentResult.rows[0].column_id;

    // Remove from old position implicitly by updating
    const newPosition = await computeNewPosition(columnId, beforeId, afterId);

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    await db.exec('COMMIT');

    const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const card = cardResult.rows[0];

    broadcast('card-moved', { card, columnId, oldColumnId });
    res.json(card);
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

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
  res.write('event: connected\ndata: {}\n\n');
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);