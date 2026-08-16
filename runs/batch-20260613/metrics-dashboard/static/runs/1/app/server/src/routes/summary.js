import { Router } from 'express';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;

    // Total visitors and total revenue across all 30 days
    const totals = await db.query(`
      SELECT
        SUM(visitors)::bigint          AS total_visitors,
        SUM(revenue)::numeric          AS total_revenue
      FROM daily_metrics
    `);

    // Best single day by revenue
    const best = await db.query(`
      SELECT date, revenue AS best_revenue
      FROM daily_metrics
      ORDER BY revenue DESC
      LIMIT 1
    `);

    // 7-day trend: compare last 7 days vs previous 7 days (by revenue)
    const trend = await db.query(`
      WITH ordered AS (
        SELECT revenue,
               ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM daily_metrics
      ),
      last7    AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn <= 7),
      prev7    AS (SELECT SUM(revenue) AS s FROM ordered WHERE rn BETWEEN 8 AND 14)
      SELECT
        last7.s                                                   AS last7,
        prev7.s                                                   AS prev7,
        CASE
          WHEN prev7.s = 0 OR prev7.s IS NULL THEN 0
          ELSE ROUND(((last7.s - prev7.s) / prev7.s) * 100, 1)
        END                                                       AS trend_pct
      FROM last7, prev7
    `);

    const { total_visitors, total_revenue } = totals.rows[0];
    const { best_revenue, date: best_date }  = best.rows[0];
    const { trend_pct, last7, prev7 }        = trend.rows[0];

    // PGLite may return DATE as a JS Date object; normalise to YYYY-MM-DD string.
    const bestDateStr = best_date instanceof Date
      ? best_date.toISOString().slice(0, 10)
      : String(best_date).slice(0, 10);

    res.json({
      total_visitors: Number(total_visitors),
      total_revenue:  Number(total_revenue),
      best_day: {
        date:    bestDateStr,
        revenue: Number(best_revenue),
      },
      trend_7d_pct: Number(trend_pct),
      trend_7d_last:  Number(last7),
      trend_7d_prev:  Number(prev7),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
