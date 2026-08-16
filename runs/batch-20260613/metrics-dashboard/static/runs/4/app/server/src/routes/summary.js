import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    // Total visitors & revenue across all 30 days
    const { rows: totals } = await db.query(`
      SELECT
        SUM(visitors)::BIGINT   AS total_visitors,
        SUM(revenue)::NUMERIC   AS total_revenue
      FROM daily_metrics
    `);

    // Best single day by revenue
    const { rows: best } = await db.query(`
      SELECT date, revenue AS best_revenue
      FROM daily_metrics
      ORDER BY revenue DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
    const { rows: trend } = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn <= 7),
      prev7   AS (SELECT SUM(visitors) AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT
        last7.s AS last_visitors,
        prev7.s AS prev_visitors,
        CASE
          WHEN prev7.s = 0 THEN 0
          ELSE ROUND(((last7.s - prev7.s)::NUMERIC / prev7.s) * 100, 1)
        END AS trend_pct
      FROM last7, prev7
    `);

    // Normalise date: PGLite may return a Date object or a string
    const rawDate = best[0].date;
    const bestDayDate = rawDate instanceof Date
      ? rawDate.toISOString().slice(0, 10)
      : String(rawDate).slice(0, 10);

    res.json({
      totalVisitors:  Number(totals[0].total_visitors),
      totalRevenue:   Number(totals[0].total_revenue),
      bestDayDate,
      bestDayRevenue: Number(best[0].best_revenue),
      trendPct:       Number(trend[0].trend_pct),
      lastVisitors:   Number(trend[0].last_visitors),
      prevVisitors:   Number(trend[0].prev_visitors),
    });
  } catch (err) {
    console.error('[summary]', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

export default router;
