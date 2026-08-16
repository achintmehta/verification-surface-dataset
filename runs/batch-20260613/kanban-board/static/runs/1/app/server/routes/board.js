/**
 * GET /api/board
 *
 * Returns the full board state: all columns ordered by position, each
 * containing their cards ordered by position.
 */

import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const { rows: columns } = await db.query(
      `SELECT id, title, position FROM columns ORDER BY position`
    );

    const { rows: cards } = await db.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards
        ORDER BY column_id, position`
    );

    // Group cards by column_id.
    /** @type {Map<string, Array>} */
    const cardsByColumn = new Map();
    for (const col of columns) {
      cardsByColumn.set(col.id, []);
    }
    for (const card of cards) {
      const list = cardsByColumn.get(card.column_id);
      if (list) list.push(card);
    }

    const board = columns.map((col) => ({
      ...col,
      cards: cardsByColumn.get(col.id) ?? [],
    }));

    res.json({ columns: board });
  } catch (err) {
    console.error('[board] GET /api/board error:', err);
    res.status(500).json({ error: 'Failed to load board state.' });
  }
});

export default router;
