import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

/**
 * GET /api/board
 * Returns all columns (ordered by position) each with their cards (ordered by position).
 */
router.get('/', async (_req, res) => {
  try {
    const db = getDb();

    const colResult = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );

    const cardResult = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position ASC'
    );

    // Group cards by column_id
    const cardsByColumn = {};
    for (const card of cardResult.rows) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const board = colResult.rows.map(col => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    res.json({ columns: board });
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

export default router;
