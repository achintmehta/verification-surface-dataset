import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize DB
await initDb();

app.get('/api/board', async (req, res) => {
  const db = getDb();
  
  const columnsRes = await db.query(`
    SELECT * FROM columns ORDER BY position
  `);
  
  const columns = [];
  for (const col of columnsRes.rows) {
    const cardsRes = await db.query(`
      SELECT id, column_id, text, position, created_at 
      FROM cards 
      WHERE column_id = $1 
      ORDER BY position
    `, [col.id]);
    
    columns.push({
      ...col,
      cards: cardsRes.rows
    });
  }
  
  res.json({ columns });
});

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text) {
    return res.status(400).json({ error: 'columnId and text required' });
  }

  const db = getDb();
  
  // Find max position in column
  const posRes = await db.query(
    'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const newPos = (posRes.rows[0].max_pos || 0) + 1000;

  const cardId = 'card-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  
  await db.query(
    `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)`,
    [cardId, columnId, text, newPos]
  );

  const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
  const card = cardRes.rows[0];

  // Broadcast
  broadcast({
    type: 'card-created',
    card,
    columnId
  });

  res.status(201).json(card);
});

app.patch('/api/cards/:id/move', async (req, res) => {
  const cardId = req.params.id;
  const { columnId, beforeId, afterId } = req.body;

  const db = getDb();

  try {
    await db.exec('BEGIN');

    // Get current card
    const currentRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentRes.rows.length === 0) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const currentCard = currentRes.rows[0];

    // Compute new position
    let newPosition;
    let needsRenormalize = false;

    if (beforeId || afterId) {
      // Get positions of neighbors
      let beforePos = null, afterPos = null;

      if (beforeId) {
        const beforeRes = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        if (beforeRes.rows.length) beforePos = beforeRes.rows[0].position;
      }
      if (afterId) {
        const afterRes = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        if (afterRes.rows.length) afterPos = afterRes.rows[0].position;
      }

      if (beforePos !== null && afterPos !== null) {
        newPosition = (beforePos + afterPos) / 2;
        // Check for collision / precision
        if (Math.abs(beforePos - afterPos) < 0.0001) {
          needsRenormalize = true;
        }
      } else if (beforePos !== null) {
        newPosition = beforePos + 1000; // shouldn't happen normally
      } else if (afterPos !== null) {
        newPosition = afterPos - 1000;
      } else {
        newPosition = 1000;
      }
    } else {
      // Append to end
      const maxRes = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      newPosition = (maxRes.rows[0].max_pos || 0) + 1000;
    }

    // Update card
    await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
      [columnId, newPosition, cardId]
    );

    // If renormalize needed
    if (needsRenormalize) {
      await renormalizeColumn(db, columnId);
    }

    await db.exec('COMMIT');

    // Fetch updated card
    const updatedRes = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updatedRes.rows[0];

    // Broadcast canonical state
    broadcast({
      type: 'card-moved',
      card: updatedCard,
      columnId
    });

    res.json(updatedCard);

  } catch (err) {
    await db.exec('ROLLBACK');
    console.error('Move error:', err);
    res.status(500).json({ error: 'Move failed' });
  }
});

async function renormalizeColumn(db, columnId) {
  const cardsRes = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  
  const cards = cardsRes.rows;
  const step = 1000;
  
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * step;
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [newPos, cards[i].id]
    );
  }

  // Broadcast renormalization event
  broadcast({
    type: 'board-renormalized',
    columnId
  });
}

app.get('/api/stream', (req, res) => {
  addClient(res);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Kanban server running on http://localhost:${PORT}`);
});