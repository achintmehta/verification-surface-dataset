import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();

    // Total visitors
    const visitorsResult = await db.query(
      'SELECT COALESCE(SUM(visitors), 0)::int AS total_visitors FROM daily_metrics'
    );
    const totalVisitors = visitorsResult.rows[0].total_visitors;

    // Total revenue
    const revenueResult = await db.query(
      'SELECT COALESCE(SUM(revenue), 0)::float AS total_revenue FROM daily_metrics'
    );
    const totalRevenue = +Number(revenueResult.rows[0].total_revenue).toFixed(2);

    // Best day (by visitors)
    const bestDayResult = await db.query(
      'SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1'
    );
    const bestDay = bestDayResult.rows[0]
      ? { date: bestDayResult.rows[0].date, visitors: bestDayResult.rows[0].visitors }
      : null;

    // 7-day trend %: compare last 7 days total visitors to previous 7 days
    const trendResult = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7 AS (SELECT COALESCE(SUM(visitors),0)::float AS s FROM ordered WHERE rn <= 7),
      prev7 AS (SELECT COALESCE(SUM(visitors),0)::float AS s FROM ordered WHERE rn > 7 AND rn <= 14)
      SELECT last7.s AS last7, prev7.s AS prev7 FROM last7, prev7
    `);
    const { last7, prev7 } = trendResult.rows[0];
    const trend = prev7 > 0 ? +((last7 - prev7) / prev7 * 100).toFixed(1) : 0;

    res.json({
      totalVisitors,
      totalRevenue,
      bestDay,
      trend,
    });
  } catch (err) {
    console.error('[summary]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
