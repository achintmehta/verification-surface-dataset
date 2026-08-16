import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { computePosition, renormalizeIfNeeded } from './position.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from client directory
app.use(express.static(path.join(__dirname, '..', 'client')));

// --- SSE Stream ---
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  // Send keepalive every 15s
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
  });

  addClient(res);
});

// --- GET /api/board ---
app.get('/api/board', async (_req, res) => {
  try {
    const db = await getDb();

    const columnsResult = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );

    const cardsResult = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const card of cardsResult.rows) {
      if (!cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id] = [];
      }
      cardsByColumn[card.column_id].push(card);
    }

    const columns = columnsResult.rows.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json({ columns });
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// --- POST /api/cards ---
app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const db = await getDb();

    // Verify column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get the max position in the column
    const maxPos = await db.query(
      'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );

    const position = maxPos.rows[0].max_pos + 1000;
    const id = 'card-' + crypto.randomUUID();

    const result = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = result.rows[0];

    broadcast('card:created', { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// --- PATCH /api/cards/:id/move ---
app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = await getDb();

    // Use a transaction for atomicity
    await db.exec('BEGIN');

    try {
      // Verify card exists
      const cardCheck = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [id]);
      if (cardCheck.rows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      const sourceColumnId = cardCheck.rows[0].column_id;

      // Verify target column exists
      const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colCheck.rows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Column not found' });
      }

      // Get positions of afterId and beforeId
      let afterPos = null;
      let beforePos = null;

      if (afterId) {
        const afterResult = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (afterResult.rows.length > 0) {
          afterPos = afterResult.rows[0].position;
        }
      }

      if (beforeId) {
        const beforeResult = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (beforeResult.rows.length > 0) {
          beforePos = beforeResult.rows[0].position;
        }
      }

      // If no neighbors specified, compute from column state
      if (!afterId && !beforeId) {
        // Place at end
        const maxPos = await db.query(
          'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id]
        );
        afterPos = maxPos.rows[0].max_pos > 0 ? maxPos.rows[0].max_pos : null;
      } else if (afterId && !beforeId) {
        // After the afterId card; get the next card as beforeId
        const nextCard = await db.query(
          'SELECT position FROM cards WHERE column_id = $1 AND position > $2 AND id != $3 ORDER BY position ASC LIMIT 1',
          [columnId, afterPos || 0, id]
        );
        if (nextCard.rows.length > 0) {
          beforePos = nextCard.rows[0].position;
        }
      } else if (!afterId && beforeId) {
        // Before the beforeId card; get the previous card as afterId
        const prevCard = await db.query(
          'SELECT position FROM cards WHERE column_id = $1 AND position < $2 AND id != $3 ORDER BY position DESC LIMIT 1',
          [columnId, beforePos || Infinity, id]
        );
        if (prevCard.rows.length > 0) {
          afterPos = prevCard.rows[0].position;
        }
      }

      const newPosition = computePosition(afterPos, beforePos);

      // Update the card atomically
      const updated = await db.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
         RETURNING id, column_id, text, position, created_at`,
        [columnId, newPosition, id]
      );

      // Check if renormalization is needed
      const renormalized = await renormalizeIfNeeded(db, columnId, newPosition, afterPos, beforePos, id);

      // If cross-column move, we might need to renormalize source column too (optional, but good hygiene)
      // Not strictly needed since removing a card doesn't cause precision issues

      await db.exec('COMMIT');

      const card = updated.rows[0];

      if (renormalized) {
        // Broadcast full column renormalization
        broadcast('column:renormalized', { columnId, cards: renormalized });
      }

      // Always broadcast the move with source column info
      broadcast('card:moved', {
        card: renormalized
          ? renormalized.find((c) => c.id === id) || card
          : card,
        sourceColumnId,
      });

      res.json({
        card: renormalized
          ? renormalized.find((c) => c.id === id) || card
          : card,
      });
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// --- DELETE /api/cards/:id ---
app.delete('/api/cards/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();

    const result = await db.query(
      'DELETE FROM cards WHERE id = $1 RETURNING id, column_id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    broadcast('card:deleted', { id, columnId: result.rows[0].column_id });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/cards/:id error:', err);
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// Catch-all: serve index.html for SPA routing
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Start server
async function start() {
  await getDb(); // Initialize database
  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

start().catch(console.error);
