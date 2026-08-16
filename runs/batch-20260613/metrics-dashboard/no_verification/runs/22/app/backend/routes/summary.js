import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();

    // Total visitors
    const totalVisitors = await db.query(
      `SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics`
    );

    // Total revenue
    const totalRevenue = await db.query(
      `SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics`
    );

    // Best day (by visitors)
    const bestDay = await db.query(
      `SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1`
    );

    // 7-day trend %: compare last 7 days to previous 7 days
    const trendQuery = await db.query(`
      WITH ordered AS (
        SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      recent AS (
        SELECT COALESCE(SUM(visitors), 0) AS total FROM ordered WHERE rn <= 7
      ),
      previous AS (
        SELECT COALESCE(SUM(visitors), 0) AS total FROM ordered WHERE rn > 7 AND rn <= 14
      )
      SELECT 
        recent.total AS recent_total,
        previous.total AS previous_total,
        CASE 
          WHEN previous.total = 0 THEN 0
          ELSE ROUND(((recent.total - previous.total)::numeric / previous.total) * 100, 1)
        END AS trend_pct
      FROM recent, previous
    `);

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      bestDay: bestDay.rows[0] ? {
        date: bestDay.rows[0].date,
        visitors: bestDay.rows[0].visitors
      } : null,
      trendPct: parseFloat(trendQuery.rows[0].trend_pct)
    });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
