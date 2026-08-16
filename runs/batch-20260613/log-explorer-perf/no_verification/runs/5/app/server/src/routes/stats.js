import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

/**
 * GET /api/stats
 * Returns: { total: number, bySeverity: { debug, info, warn, error } }
 */
router.get('/', async (req, res) => {
  try {
    const db = await getDb();

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
    console.error('[GET /api/stats]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
