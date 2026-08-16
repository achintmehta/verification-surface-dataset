import { Router } from 'express';

export function createStatsRouter(db) {
  const router = Router();

  /**
   * GET /api/stats
   * Returns total row count and per-severity counts.
   * Response: { total: number, bySeverity: { debug: n, info: n, warn: n, error: n } }
   */
  router.get('/', async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE severity = 'debug') AS debug,
          COUNT(*) FILTER (WHERE severity = 'info')  AS info,
          COUNT(*) FILTER (WHERE severity = 'warn')  AS warn,
          COUNT(*) FILTER (WHERE severity = 'error') AS error
        FROM logs
      `);

      const row = result.rows[0];
      return res.json({
        total: parseInt(row.total, 10),
        bySeverity: {
          debug: parseInt(row.debug, 10),
          info:  parseInt(row.info,  10),
          warn:  parseInt(row.warn,  10),
          error: parseInt(row.error, 10),
        },
      });
    } catch (err) {
      console.error('[stats] Query error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
