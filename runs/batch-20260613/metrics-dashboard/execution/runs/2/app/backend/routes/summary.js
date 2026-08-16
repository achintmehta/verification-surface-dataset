/**
 * GET /api/summary
 *
 * Returns four headline numbers derived from daily_metrics:
 *   totalVisitors  – sum of all 30 days
 *   totalRevenue   – sum of all 30 days
 *   bestDay        – { date, visitors, revenue } for the day with most visitors
 *   trend7d        – % change in visitors: last 7 days vs previous 7 days
 */

import { Router } from 'express';
import { getDb }   from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const db = getDb();

    // Totals
    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint          AS "totalVisitors",
        SUM(revenue)::numeric          AS "totalRevenue"
      FROM daily_metrics
    `);

    // Best day by visitors
    const best = await db.query(`
      SELECT date, visitors, revenue
      FROM   daily_metrics
      ORDER  BY visitors DESC
      LIMIT  1
    `);

    // 7-day trend
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors,
               ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM   daily_metrics
      ),
      last7  AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn <= 7),
      prev7  AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn BETWEEN 8 AND 14)
      SELECT
        last7.s                                                   AS last7,
        prev7.s                                                   AS prev7,
        CASE
          WHEN prev7.s = 0 THEN NULL
          ELSE ROUND(((last7.s - prev7.s)::numeric / prev7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    const { totalVisitors, totalRevenue } = totals.rows[0];
    const bestDay = best.rows[0] ?? null;
    const { trend_pct } = trend.rows[0];

    res.json({
      totalVisitors: Number(totalVisitors),
      totalRevenue:  Number(totalRevenue),
      bestDay: bestDay
        ? {
            date:     bestDay.date instanceof Date
                        ? bestDay.date.toISOString().slice(0, 10)
                        : String(bestDay.date).slice(0, 10),
            visitors: Number(bestDay.visitors),
            revenue:  Number(bestDay.revenue),
          }
        : null,
      trend7d: trend_pct !== null ? Number(trend_pct) : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
