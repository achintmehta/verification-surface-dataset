/**
 * GET /api/stats
 * Returns: { total: number, bySeverity: { debug: number, info: number, warn: number, error: number } }
 */

import express from 'express';

export function statsRouter(db) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const result = await db.query(`
        SELECT severity, COUNT(*) AS cnt
        FROM logs
        GROUP BY severity
      `);

      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      let total = 0;

      for (const row of result.rows) {
        const count = parseInt(row.cnt, 10);
        bySeverity[row.severity] = count;
        total += count;
      }

      return res.json({ total, bySeverity });
    } catch (err) {
      console.error('[GET /api/stats] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
