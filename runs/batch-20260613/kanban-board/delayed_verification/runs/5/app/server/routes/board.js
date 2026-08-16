/**
 * routes/board.js – GET /api/board
 *
 * Returns the full board state: every column (ordered by position) with its
 * cards (ordered by position within the column).
 */

import { Router } from 'express';
import { getDb }  from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const db = await getDb();

    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position'
    );

    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position'
    );

    // Group cards by column_id for O(n) assembly.
    const cardsByColumn = {};
    for (const card of cards) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const board = columns.map(col => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    res.json({ columns: board });
  } catch (err) {
    next(err);
  }
});

export default router;
