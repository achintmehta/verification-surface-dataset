import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    // Total visitors and total revenue across all 30 days
    const totals = await db.query(`
      SELECT
        SUM(visitors)::BIGINT   AS total_visitors,
        SUM(revenue)::NUMERIC   AS total_revenue
      FROM daily_metrics
    `);

    // Best single day by revenue
    const best = await db.query(`
      SELECT date::TEXT, revenue AS best_revenue
      FROM daily_metrics
      ORDER BY revenue DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days (by revenue)
    const trend = await db.query(`
      WITH ordered AS (
        SELECT revenue, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        last7.s AS last_7,
        prev7.s AS prev_7,
        CASE
          WHEN prev7.s = 0 OR prev7.s IS NULL THEN 0
          ELSE ROUND(((last7.s - prev7.s) / prev7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    const row = totals.rows[0];
    const bestRow = best.rows[0];
    const trendRow = trend.rows[0];

    res.json({
      total_visitors: parseInt(row.total_visitors, 10),
      total_revenue:  parseFloat(row.total_revenue),
      best_day: {
        date:    bestRow.date,
        revenue: parseFloat(bestRow.best_revenue),
      },
      trend_pct: parseFloat(trendRow.trend_pct),
    });
  } catch (err) {
    console.error('[/api/summary]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
