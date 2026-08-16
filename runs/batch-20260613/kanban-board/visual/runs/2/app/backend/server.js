import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { between, needsRenorm, renormalize } from './ordering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// ─── SSE ──────────────────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

// ─── Board state ──────────────────────────────────────────────────────────────

app.get('/api/board', async (_req, res) => {
  try {
    const db = getDb();

    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position'
    );

    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const col of columns) cardsByColumn[col.id] = [];
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const board = columns.map(col => ({
      ...col,
      cards: cardsByColumn[col.id],
    }));

    res.json({ columns: board });
  } catch (err) {
    console.error('[GET /api/board]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create card ──────────────────────────────────────────────────────────────

app.post('/api/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text?.trim()) {
    return res.status(400).json({ error: 'columnId and text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = rows[0].max_pos !== null ? parseFloat(rows[0].max_pos) : 0;
    const position = maxPos + 1000;

    const id = randomUUID();
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text.trim(), position]
    );

    const { rows: created } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );
    const card = created[0];

    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Move card ────────────────────────────────────────────────────────────────
//
// Body: { columnId, beforeId?, afterId? }
//   beforeId = id of the card that should come BEFORE the moved card (null = moved card goes first)
//   afterId  = id of the card that should come AFTER  the moved card (null = moved card goes last)
//
// The server is authoritative: it reads the current positions of beforeId /
// afterId from the DB, computes the canonical new position, and persists it
// atomically.

app.patch('/api/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Run everything in a single serialisable transaction
    await db.query('BEGIN');

    try {
      // Verify card exists
      const { rows: cardRows } = await db.query(
        'SELECT id FROM cards WHERE id = $1',
        [id]
      );
      if (cardRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      // Verify column exists
      const { rows: colRows } = await db.query(
        'SELECT id FROM columns WHERE id = $1',
        [columnId]
      );
      if (colRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Column not found' });
      }

      // Fetch positions of neighbours (excluding the card being moved itself)
      let beforePos = null;
      let afterPos  = null;

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length > 0) beforePos = parseFloat(rows[0].position);
      }

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length > 0) afterPos = parseFloat(rows[0].position);
      }

      // If neither neighbour was found in the target column, place at end
      let newPosition = between(beforePos, afterPos);

      // Update the card atomically
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, id]
      );

      await db.query('COMMIT');

      // Fetch the canonical card
      const { rows: updated } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      let card = updated[0];

      // ── Renormalisation check ──────────────────────────────────────────────
      // Check if any two adjacent cards in the column are too close together
      const { rows: colCards } = await db.query(
        'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position',
        [columnId]
      );

      let needsRenormFlag = false;
      for (let i = 0; i < colCards.length - 1; i++) {
        if (needsRenorm(parseFloat(colCards[i].position), parseFloat(colCards[i + 1].position))) {
          needsRenormFlag = true;
          break;
        }
      }

      if (needsRenormFlag) {
        const renormed = renormalize(colCards.map(c => ({ id: c.id, position: parseFloat(c.position) })));
        await db.query('BEGIN');
        for (const c of renormed) {
          await db.query('UPDATE cards SET position = $1 WHERE id = $2', [c.position, c.id]);
        }
        await db.query('COMMIT');

        // Re-fetch the moved card's canonical position after renorm
        const { rows: reloaded } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [id]
        );
        card = reloaded[0];

        // Broadcast the full renormed column
        const { rows: renormedCards } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position',
          [columnId]
        );
        broadcast('column:reordered', { columnId, cards: renormedCards });
      }

      broadcast('card:moved', { card });
      res.json({ card });
    } catch (innerErr) {
      await db.query('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve built frontend ─────────────────────────────────────────────────────

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
