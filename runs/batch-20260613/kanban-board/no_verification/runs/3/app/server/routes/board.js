/**
 * GET /api/board
 * Returns the full board state: all columns ordered by position, each with
 * their cards ordered by position.
 */

import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const colResult = await db.query(
      `SELECT id, title, position FROM columns ORDER BY position`
    );

    const cardResult = await db.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards
        ORDER BY column_id, position`
    );

    // Group cards by column_id.
    const cardsByColumn = {};
    for (const card of cardResult.rows) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const columns = colResult.rows.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    res.json({ columns });
  } catch (err) {
    console.error('[board] GET /api/board error:', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

export default router;
