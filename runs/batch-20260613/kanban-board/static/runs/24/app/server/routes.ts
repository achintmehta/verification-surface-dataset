import { Router, type Request, type Response } from 'express';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import type { Card, Column, CreateCardRequest, MoveCardRequest } from '../shared/types.js';

const router = Router();

// --------------- Helpers ---------------

const POSITION_GAP = 1000;
const MIN_POSITION_GAP = 0.001;

interface CardRow {
  id: string;
  column_id: string;
  text: string;
  position: number;
  created_at: string;
}

interface ColumnRow {
  id: string;
  title: string;
  position: number;
}

function cardRowToCard(row: CardRow): Card {
  return {
    id: row.id,
    column_id: row.column_id,
    text: row.text,
    position: row.position,
    created_at: row.created_at,
  };
}

/**
 * Renormalize all positions in a column to evenly-spaced integers.
 * Returns the renormalized cards and broadcasts the event.
 */
async function renormalizeColumn(columnId: string): Promise<Card[]> {
  const db = await getDb();
  const result = await db.query<CardRow>(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC',
    [columnId]
  );

  const cards: Card[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const newPosition = (i + 1) * POSITION_GAP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPosition, result.rows[i].id]);
    cards.push({
      ...cardRowToCard(result.rows[i]),
      position: newPosition,
    });
  }

  broadcast({
    type: 'column_renormalized',
    columnId,
    cards,
  });

  return cards;
}

/**
 * Compute a position between two values.
 * Returns null if the gap is too small and renormalization is needed.
 */
function computePositionBetween(after: number | null, before: number | null): number | null {
  if (after === null && before === null) {
    return POSITION_GAP;
  }
  if (after === null) {
    // Insert at the beginning
    const pos = before! / 2;
    if (pos < MIN_POSITION_GAP) {
      return null; // needs renormalization
    }
    return pos;
  }
  if (before === null) {
    // Insert at the end
    return after + POSITION_GAP;
  }
  const gap = before - after;
  if (gap < MIN_POSITION_GAP) {
    return null; // needs renormalization
  }
  return after + gap / 2;
}

// --------------- GET /api/board ---------------

router.get('/board', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    const columnsResult = await db.query<ColumnRow>('SELECT * FROM columns ORDER BY position ASC');
    const cardsResult = await db.query<CardRow>('SELECT * FROM cards ORDER BY position ASC, created_at ASC');

    const cardsByColumn = new Map<string, Card[]>();
    for (const row of cardsResult.rows) {
      const card = cardRowToCard(row);
      if (!cardsByColumn.has(card.column_id)) {
        cardsByColumn.set(card.column_id, []);
      }
      cardsByColumn.get(card.column_id)!.push(card);
    }

    const columns: Column[] = columnsResult.rows.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByColumn.get(col.id) || [],
    }));

    res.json({ columns });
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// --------------- POST /api/cards ---------------

router.post('/cards', async (req: Request, res: Response): Promise<void> => {
  try {
    const { column_id, text } = req.body as CreateCardRequest;
    if (!column_id || !text || !text.trim()) {
      res.status(400).json({ error: 'column_id and text are required' });
      return;
    }

    const db = await getDb();

    // Verify column exists
    const colCheck = await db.query<{ id: string }>('SELECT id FROM columns WHERE id = $1', [column_id]);
    if (colCheck.rows.length === 0) {
      res.status(404).json({ error: 'Column not found' });
      return;
    }

    // Get the maximum position in the column
    const maxResult = await db.query<{ max_pos: number | null }>(
      'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1',
      [column_id]
    );
    const maxPos = maxResult.rows[0].max_pos;
    const newPosition = maxPos !== null ? maxPos + POSITION_GAP : POSITION_GAP;

    const insertResult = await db.query<CardRow>(
      `INSERT INTO cards (column_id, text, position)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [column_id, text.trim(), newPosition]
    );

    const card = cardRowToCard(insertResult.rows[0]);

    broadcast({
      type: 'card_created',
      card,
    });

    res.status(201).json(card);
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// --------------- PATCH /api/cards/:id/move ---------------

router.patch('/cards/:id/move', async (req: Request, res: Response): Promise<void> => {
  try {
    const cardId = req.params.id;
    const { columnId, afterId, beforeId } = req.body as MoveCardRequest;

    if (!columnId) {
      res.status(400).json({ error: 'columnId is required' });
      return;
    }

    const db = await getDb();

    // Use a transaction for atomicity
    await db.exec('BEGIN');

    try {
      // Fetch the card being moved
      const cardResult = await db.query<CardRow>('SELECT * FROM cards WHERE id = $1', [cardId]);
      if (cardResult.rows.length === 0) {
        await db.exec('ROLLBACK');
        res.status(404).json({ error: 'Card not found' });
        return;
      }

      const previousColumnId = cardResult.rows[0].column_id;

      // Verify target column exists
      const colCheck = await db.query<{ id: string }>('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colCheck.rows.length === 0) {
        await db.exec('ROLLBACK');
        res.status(404).json({ error: 'Target column not found' });
        return;
      }

      // Get positions of afterId and beforeId
      let afterPosition: number | null = null;
      let beforePosition: number | null = null;

      if (afterId) {
        const afterResult = await db.query<CardRow>(
          'SELECT * FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (afterResult.rows.length > 0) {
          afterPosition = afterResult.rows[0].position;
        }
      }

      if (beforeId) {
        const beforeResult = await db.query<CardRow>(
          'SELECT * FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (beforeResult.rows.length > 0) {
          beforePosition = beforeResult.rows[0].position;
        }
      }

      // If afterId and beforeId are not found (maybe deleted/moved), fall back to end of column
      if (!afterId && !beforeId) {
        // Placing at position: end of column
        const maxResult = await db.query<{ max_pos: number | null }>(
          'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, cardId]
        );
        afterPosition = maxResult.rows[0].max_pos;
      }

      let newPosition = computePositionBetween(afterPosition, beforePosition);

      // If position gap is too small, renormalize first, then recompute
      if (newPosition === null) {
        // Commit the current transaction, renormalize, then start a new one
        await db.exec('COMMIT');

        // Renormalize the target column (excluding the card being moved if it's already there)
        await renormalizeColumn(columnId);

        await db.exec('BEGIN');

        // Re-fetch positions after renormalization
        afterPosition = null;
        beforePosition = null;

        if (afterId) {
          const afterResult = await db.query<CardRow>(
            'SELECT * FROM cards WHERE id = $1 AND column_id = $2',
            [afterId, columnId]
          );
          if (afterResult.rows.length > 0) {
            afterPosition = afterResult.rows[0].position;
          }
        }

        if (beforeId) {
          const beforeResult = await db.query<CardRow>(
            'SELECT * FROM cards WHERE id = $1 AND column_id = $2',
            [beforeId, columnId]
          );
          if (beforeResult.rows.length > 0) {
            beforePosition = beforeResult.rows[0].position;
          }
        }

        newPosition = computePositionBetween(afterPosition, beforePosition);
        if (newPosition === null) {
          // Fallback: place at end
          const maxResult = await db.query<{ max_pos: number | null }>(
            'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1 AND id != $2',
            [columnId, cardId]
          );
          const max = maxResult.rows[0].max_pos;
          newPosition = max !== null ? max + POSITION_GAP : POSITION_GAP;
        }
      }

      // Atomically update the card's column and position
      const updateResult = await db.query<CardRow>(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *`,
        [columnId, newPosition, cardId]
      );

      await db.exec('COMMIT');

      const card = cardRowToCard(updateResult.rows[0]);

      broadcast({
        type: 'card_moved',
        card,
        previousColumnId,
      });

      res.json(card);
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// --------------- GET /api/stream (SSE) ---------------

router.get('/stream', (req: Request, res: Response): void => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial connected event
  res.write('event: connected\ndata: {}\n\n');

  const cleanup = addClient(res);

  req.on('close', () => {
    cleanup();
  });
});

export default router;
