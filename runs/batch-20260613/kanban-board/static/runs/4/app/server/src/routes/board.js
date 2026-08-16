/**
 * GET /api/board
 *
 * Returns the full board state: all columns ordered by position,
 * each with their cards ordered by position ascending.
 *
 * Response shape:
 * {
 *   columns: [
 *     {
 *       id: string,
 *       title: string,
 *       position: number,
 *       cards: [{ id, column_id, text, position, created_at }, ...]
 *     },
 *     ...
 *   ]
 * }
 */

import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const { rows: columns } = await query(
      'SELECT id, title, position FROM columns ORDER BY position ASC',
    );

    const { rows: cards } = await query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position ASC',
    );

    // Group cards by column_id
    const cardsByColumn = {};
    for (const card of cards) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const result = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    res.json({ columns: result });
  } catch (err) {
    console.error('[GET /api/board]', err);
    res.status(500).json({ error: 'Failed to load board state.' });
  }
});

export default router;
