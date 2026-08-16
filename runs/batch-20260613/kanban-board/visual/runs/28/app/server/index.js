const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize PGLite
let db;
let clients = new Set();

async function initDb() {
  db = new PGlite('./pgdata');
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
  if (parseInt(rows[0].count) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES 
      ('col-todo', 'To Do', 1),
      ('col-progress', 'In Progress', 2),
      ('col-done', 'Done', 3);
    `);
  }
}

function broadcast(event, data) {
  const message = `data: ${JSON.stringify({ event, data })}\n\n`;
  clients.forEach(client => {
    client.write(message);
  });
}

async function renormalizeColumn(columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  
  if (cards.length === 0) return;
  
  // Assign positions 1, 2, 3, ...
  for (let i = 0; i < cards.length; i++) {
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [i + 1, cards[i].id]
    );
  }
  
  // Broadcast updated column
  const { rows: updatedCards } = await db.query(
    `SELECT c.*, col.id as column_id FROM cards c 
     JOIN columns col ON c.column_id = col.id 
     WHERE c.column_id = $1 ORDER BY c.position`,
    [columnId]
  );
  
  broadcast('column-renormalized', { columnId, cards: updatedCards });
}

app.get('/api/board', async (req, res) => {
  try {
    const { rows: columns } = await db.query(
      'SELECT * FROM columns ORDER BY position'
    );
    
    const board = [];
    for (const col of columns) {
      const { rows: cards } = await db.query(
        'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
        [col.id]
      );
      board.push({ ...col, cards });
    }
    
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
    const { rows: maxPosRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const position = parseFloat(maxPosRows[0].max_pos) + 1;
    
    const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text, position]
    );
    
    const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = rows[0];
    
    broadcast('card-created', { card, columnId });
    
    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;
  
  if (!columnId) {
    return res.status(400).json({ error: 'columnId required' });
  }
  
  try {
    await db.exec('BEGIN');
    
    // Get current card info
    const { rows: currentRows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentRows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const currentCard = currentRows[0];
    const oldColumnId = currentCard.column_id;
    
    // Compute new position
    let newPosition;
    
    if (beforeId && afterId) {
      // Between two cards
      const { rows: beforeRows } = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const { rows: afterRows } = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      
      if (beforeRows.length && afterRows.length) {
        const beforePos = parseFloat(beforeRows[0].position);
        const afterPos = parseFloat(afterRows[0].position);
        newPosition = (beforePos + afterPos) / 2;
      } else {
        newPosition = 1;
      }
    } else if (beforeId) {
      // Before a specific card (at beginning or specific spot)
      const { rows: beforeRows } = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (beforeRows.length) {
        newPosition = parseFloat(beforeRows[0].position) - 0.5;
      } else {
        newPosition = 1;
      }
    } else if (afterId) {
      // After a specific card (at end or specific)
      const { rows: afterRows } = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (afterRows.length) {
        newPosition = parseFloat(afterRows[0].position) + 0.5;
      } else {
        newPosition = 1;
      }
    } else {
      // At end of column
      const { rows: maxRows } = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      newPosition = parseFloat(maxRows[0].max_pos) + 1;
    }
    
    // Update card
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPosition, cardId]
    );
    
    await db.exec('COMMIT');
    
    // Check for position collision or precision issues
    const { rows: samePosRows } = await db.query(
      'SELECT COUNT(*) as cnt FROM cards WHERE column_id = $1 AND position = $2',
      [columnId, newPosition]
    );
    
    if (parseInt(samePosRows[0].cnt) > 1) {
      await renormalizeColumn(columnId);
    }
    
    // Fetch updated card
    const { rows: updatedRows } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRows[0];
    
    broadcast('card-moved', { card: updatedCard, columnId, oldColumnId });
    
    res.json(updatedCard);
  } catch (err) {
    await db.exec('ROLLBACK');
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
  
  // Send initial ping
  res.write('data: {"event":"connected"}\n\n');
  
  req.on('close', () => {
    clients.delete(res);
  });
});

async function start() {
  await initDb();
  
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);