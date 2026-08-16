import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

/**
 * GET /api/board
 * Returns all columns (ordered by position) each with their cards
 * (ordered by position ascending).
 */
router.get('/', async (_req, res) => {
  try {
    const db = getDb();

    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );

    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const col of columns) cardsByColumn[col.id] = [];
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const board = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json({ columns: board });
  } catch (err) {
    console.error('[GET /api/board]', err);
    res.status(500).json({ error: 'Failed to load board state.' });
  }
});

export default router;
