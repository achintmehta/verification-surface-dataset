/**
 * GET /api/summary
 *
 * Returns four headline numbers computed from daily_metrics:
 *   - totalVisitors  : sum of all visitors
 *   - totalRevenue   : sum of all revenue
 *   - bestDay        : { date, visitors, revenue } for the day with most visitors
 *   - trend7d        : percentage change in visitors: last 7 days vs prior 7 days
 */

import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    const { rows: totals } = await db.query(`
      SELECT
        SUM(visitors)::BIGINT   AS "totalVisitors",
        SUM(revenue)::NUMERIC   AS "totalRevenue"
      FROM daily_metrics
    `);

    const { rows: best } = await db.query(`
      SELECT date, visitors, revenue
      FROM daily_metrics
      ORDER BY visitors DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs preceding 7 days
    const { rows: trend } = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      )
      SELECT
        SUM(CASE WHEN rn <= 7  THEN visitors ELSE 0 END) AS last7,
        SUM(CASE WHEN rn > 7 AND rn <= 14 THEN visitors ELSE 0 END) AS prev7
      FROM ordered
    `);

    const last7 = parseFloat(trend[0].last7) || 0;
    const prev7 = parseFloat(trend[0].prev7) || 0;
    const trend7d = prev7 === 0 ? 0 : ((last7 - prev7) / prev7) * 100;

    // PGLite may return date as a Date object or a string; normalise to YYYY-MM-DD
    const bestDate = best[0].date instanceof Date
      ? best[0].date.toISOString().slice(0, 10)
      : String(best[0].date).slice(0, 10);

    res.json({
      totalVisitors: parseInt(totals[0].totalVisitors, 10),
      totalRevenue:  parseFloat(totals[0].totalRevenue),
      bestDay: {
        date:     bestDate,
        visitors: parseInt(best[0].visitors, 10),
        revenue:  parseFloat(best[0].revenue),
      },
      trend7d: parseFloat(trend7d.toFixed(2)),
    });
  } catch (err) {
    console.error('[summary]', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

export default router;
