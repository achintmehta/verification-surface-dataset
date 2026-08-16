import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    // Total visitors and total revenue across all 30 days
    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint          AS total_visitors,
        SUM(revenue)::numeric          AS total_revenue
      FROM daily_metrics
    `);

    // Best single day by revenue
    const best = await db.query(`
      SELECT date, revenue
      FROM daily_metrics
      ORDER BY revenue DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
    const trend = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT SUM(visitors)::float AS s FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT SUM(visitors)::float AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        CASE
          WHEN prev7.s = 0 THEN 0
          ELSE ROUND(((last7.s - prev7.s) / prev7.s * 100)::numeric, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    res.json({
      total_visitors: Number(totals.rows[0].total_visitors),
      total_revenue:  Number(totals.rows[0].total_revenue),
      best_day: {
        date:    best.rows[0]?.date,
        revenue: Number(best.rows[0]?.revenue ?? 0),
      },
      trend_pct: Number(trend.rows[0]?.trend_pct ?? 0),
    });
  } catch (err) {
    console.error('[summary]', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

export default router;
