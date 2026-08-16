import { Router } from 'express';

/**
 * GET /api/board
 * Returns all columns with their cards ordered by position.
 */
export function createBoardRoutes(db) {
  const router = Router();

  router.get('/board', async (_req, res) => {
    try {
      const { rows: columns } = await db.query(
        'SELECT id, title, position FROM columns ORDER BY position'
      );

      const { rows: cards } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position'
      );

      // Group cards by column
      const cardsByColumn = {};
      for (const col of columns) {
        cardsByColumn[col.id] = [];
      }
      for (const card of cards) {
        if (cardsByColumn[card.column_id]) {
          cardsByColumn[card.column_id].push(card);
        }
      }

      const result = columns.map(col => ({
        id: col.id,
        title: col.title,
        position: col.position,
        cards: cardsByColumn[col.id] || [],
      }));

      res.json(result);
    } catch (err) {
      console.error('GET /api/board error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
