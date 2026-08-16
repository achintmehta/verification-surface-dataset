/**
 * GET /api/timeseries
 *
 * Returns all 30 daily_metrics rows ordered by date ascending.
 * Shape: { data: [{ date, visitors, revenue }, …] }
 */

import { Router } from 'express';
import { getDb }   from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const db = getDb();
    const { rows } = await db.query(`
      SELECT
        date,
        visitors::int     AS visitors,
        revenue::numeric  AS revenue
      FROM   daily_metrics
      ORDER  BY date ASC
    `);

    res.json({
      data: rows.map(r => ({
        date:     r.date instanceof Date
                    ? r.date.toISOString().slice(0, 10)
                    : String(r.date).slice(0, 10),
        visitors: Number(r.visitors),
        revenue:  Number(r.revenue),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
