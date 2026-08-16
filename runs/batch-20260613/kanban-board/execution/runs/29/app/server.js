const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize PGLite with file system persistence
const db = new PGlite('./kanban-data');

let clients = []; // SSE clients

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

function broadcast(event, data) {
  clients.forEach(client => {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

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

    const card = { id, column_id: columnId, text, position: newPos };
    broadcast('card-created', { card });
    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

async function computePosition(columnId, beforeId, afterId) {
  let beforePos = null, afterPos = null;

  if (beforeId) {
    const r = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
    if (r.rows.length) beforePos = r.rows[0].position;
  }
  if (afterId) {
    const r = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
    if (r.rows.length) afterPos = r.rows[0].position;
  }

  let newPos;
  if (beforePos !== null && afterPos !== null) {
    newPos = (beforePos + afterPos) / 2;
  } else if (beforePos !== null) {
    newPos = beforePos + 1000;
  } else if (afterPos !== null) {
    newPos = afterPos - 1000;
  } else {
    // end of column
    const max = await db.query('SELECT COALESCE(MAX(position), 0) as max FROM cards WHERE column_id = $1', [columnId]);
    newPos = (max.rows[0].max || 0) + 1000;
  }

  // Check for collision or precision issues
  if (beforePos !== null && afterPos !== null && Math.abs(beforePos - afterPos) < 0.0001) {
    // Need renormalization
    await renormalizeColumn(columnId);
    // Recompute
    return await computePosition(columnId, beforeId, afterId);
  }

  return newPos;
}

async function renormalizeColumn(columnId) {
  const cards = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  let pos = 1000;
  for (const card of cards.rows) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, card.id]);
    pos += 1000;
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

    // Get current column to check if changing
    const current = await db.query('SELECT column_id FROM cards WHERE id = $1', [cardId]);
    if (current.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const oldColumnId = current.rows[0].column_id;

    const newPosition = await computePosition(columnId, beforeId, afterId);

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );

    await db.exec('COMMIT');

    const updatedCard = {
      id: cardId,
      column_id: columnId,
      position: newPosition
    };

    broadcast('card-moved', { card: updatedCard, oldColumnId });
    res.json(updatedCard);
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
  res.flushHeaders();

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);
