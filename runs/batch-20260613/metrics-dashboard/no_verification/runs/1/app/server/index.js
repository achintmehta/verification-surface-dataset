import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;

async function main() {
  const db = await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── Summary ──────────────────────────────────────────────────────────────
  app.get('/api/summary', async (_req, res) => {
    try {
      // Total visitors
      const tvRes = await db.query(
        `SELECT COALESCE(SUM(visitors), 0)::bigint AS total FROM daily_metrics`
      );
      const totalVisitors = Number(tvRes.rows[0].total);

      // Total revenue
      const trRes = await db.query(
        `SELECT COALESCE(SUM(revenue), 0)::numeric AS total FROM daily_metrics`
      );
      const totalRevenue = Number(trRes.rows[0].total);

      // Best day (highest visitors)
      const bdRes = await db.query(
        `SELECT date::text AS date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1`
      );
      const bestDay = bdRes.rows[0] || null;

      // 7-day trend: compare last 7 days vs previous 7 days (by visitors)
      const trendRes = await db.query(`
        WITH ordered AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        last7   AS (SELECT SUM(visitors)::bigint AS s FROM ordered WHERE rn <= 7),
        prev7   AS (SELECT SUM(visitors)::bigint AS s FROM ordered WHERE rn > 7 AND rn <= 14)
        SELECT last7.s AS last7, prev7.s AS prev7 FROM last7, prev7
      `);
      const last7 = Number(trendRes.rows[0]?.last7 ?? 0);
      const prev7 = Number(trendRes.rows[0]?.prev7 ?? 0);
      const trendPct =
        prev7 === 0 ? 0 : Math.round(((last7 - prev7) / prev7) * 1000) / 10;

      res.json({
        totalVisitors,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        bestDay: bestDay
          ? { date: bestDay.date, visitors: Number(bestDay.visitors) }
          : null,
        sevenDayTrendPct: trendPct,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to compute summary' });
    }
  });

  // ── Time-series ───────────────────────────────────────────────────────────
  app.get('/api/timeseries', async (_req, res) => {
    try {
      const result = await db.query(
        `SELECT date::text AS date, visitors, revenue FROM daily_metrics ORDER BY date ASC`
      );
      res.json(
        result.rows.map((r) => ({
          date: r.date,          // already a "YYYY-MM-DD" string via ::text
          visitors: Number(r.visitors),
          revenue: Number(r.revenue),
        }))
      );
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch timeseries' });
    }
  });

  // ── Categories ────────────────────────────────────────────────────────────
  app.get('/api/categories', async (_req, res) => {
    try {
      const result = await db.query(
        `SELECT name, value FROM categories ORDER BY value DESC`
      );
      res.json(
        result.rows.map((r) => ({ name: r.name, value: Number(r.value) }))
      );
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  // ── Recent items ──────────────────────────────────────────────────────────
  app.get('/api/recent', async (_req, res) => {
    try {
      const result = await db.query(
        `SELECT id, name, category, value, created_at
         FROM recent_items
         ORDER BY created_at DESC
         LIMIT 20`
      );
      res.json(
        result.rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          category: r.category,
          value: Number(r.value),
          createdAt: r.created_at,
        }))
      );
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch recent items' });
    }
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  app.get('/api/settings', async (_req, res) => {
    try {
      const result = await db.query(`SELECT theme FROM settings LIMIT 1`);
      const theme = result.rows[0]?.theme ?? 'light';
      res.json({ theme });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  app.put('/api/settings', async (req, res) => {
    try {
      const { theme } = req.body;
      if (theme !== 'light' && theme !== 'dark') {
        return res.status(400).json({ error: 'theme must be "light" or "dark"' });
      }
      await db.query(`UPDATE settings SET theme = $1`, [theme]);
      res.json({ theme });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
