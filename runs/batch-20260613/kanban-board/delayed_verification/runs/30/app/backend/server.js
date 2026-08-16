import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const db = new PGlite({ dataDir: './data' });

let sseClients = [];

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => {
    client.write(message);
  });
}

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const countRes = await db.query('SELECT COUNT(*) as count FROM columns');
  if (parseInt(countRes.rows[0].count) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES 
      ('col-todo', 'To Do', 0),
      ('col-progress', 'In Progress', 1),
      ('col-done', 'Done', 2)
    `);
  }
}

async function getBoardState() {
  const columnsRes = await db.query('SELECT * FROM columns ORDER BY position');
  const columns = columnsRes.rows;

  for (const column of columns) {
    const cardsRes = await db.query(
      'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
      [column.id]
    );
    column.cards = cardsRes.rows;
  }
  return columns;
}

async function computePosition(columnId, afterId, beforeId) {
  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const res = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
    if (res.rows.length > 0) afterPos = res.rows[0].position;
  }
  if (beforeId) {
    const res = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
    if (res.rows.length > 0) beforePos = res.rows[0].position;
  }

  let newPos;
  if (afterPos !== null && beforePos !== null) {
    newPos = (afterPos + beforePos) / 2;
  } else if (afterPos !== null) {
    newPos = afterPos + 1000;
  } else if (beforePos !== null) {
    newPos = beforePos - 1000;
  } else {
    const maxRes = await db.query(
      'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    newPos = (maxRes.rows[0].max_pos || 0) + 1000;
  }
  return newPos;
}

async function renormalizeColumn(columnId) {
  const cardsRes = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }
  return cards.length;
}

async function checkAndRenormalize(columnId) {
  const cardsRes = await db.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const positions = cardsRes.rows.map(r => r.position);
  let needsRenorm = false;
  for (let i = 1; i < positions.length; i++) {
    if (Math.abs(positions[i] - positions[i-1]) < 0.001) {
      needsRenorm = true;
      break;
    }
  }
  if (needsRenorm) {
    await renormalizeColumn(columnId);
    return true;
  }
  return false;
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
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text required' });
    }
    const id = `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newPos = await computePosition(columnId, null, null);
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, newPos]
    );
    const card = { id, column_id: columnId, text, position: newPos };
    broadcast('card-created', { card });
    res.json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const cardId = req.params.id;
    const { columnId, beforeId, afterId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId required' });
    }

    // Use transaction-like by sequential ops, but careful
    await db.exec('BEGIN TRANSACTION');

    // Get current card to know old column
    const currentRes = await db.query('SELECT column_id FROM cards WHERE id = $1', [cardId]);
    if (currentRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const oldColumnId = currentRes.rows[0].column_id;

    const newPos = await computePosition(columnId, afterId, beforeId);

    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPos, cardId]
    );

    let didRenorm = await checkAndRenormalize(columnId);
    if (oldColumnId !== columnId) {
      await checkAndRenormalize(oldColumnId);
    }

    await db.exec('COMMIT');

    // Fetch updated card
    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    broadcast('card-moved', { card: updatedCard });

    if (didRenorm) {
      // Broadcast full column update for renorm case
      const board = await getBoardState();
      broadcast('board-update', { columns: board });
    }

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
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Kanban backend running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);