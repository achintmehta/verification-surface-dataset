const express = require("express");
const cors = require("cors");
const path = require("path");
const { initDB } = require("./db");

const PORT = process.env.PORT || 3001;

async function main() {
  const db = await initDB();
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Serve built frontend in production ---
  const frontendDist = path.join(__dirname, "..", "frontend", "dist");
  app.use(express.static(frontendDist));

  // ===== API Routes =====

  // GET /api/summary — four headline numbers
  app.get("/api/summary", async (_req, res) => {
    try {
      const totalVisitors = await db.query(
        "SELECT COALESCE(SUM(visitors), 0) AS total FROM daily_metrics"
      );
      const totalRevenue = await db.query(
        "SELECT COALESCE(SUM(revenue), 0) AS total FROM daily_metrics"
      );
      const bestDay = await db.query(
        "SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1"
      );

      // 7-day trend: compare last 7 days avg vs previous 7 days avg
      const trend = await db.query(`
        WITH ordered AS (
          SELECT visitors, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM daily_metrics
        ),
        last7 AS (SELECT AVG(visitors) AS avg_val FROM ordered WHERE rn <= 7),
        prev7 AS (SELECT AVG(visitors) AS avg_val FROM ordered WHERE rn > 7 AND rn <= 14)
        SELECT
          last7.avg_val AS last_avg,
          prev7.avg_val AS prev_avg,
          CASE
            WHEN prev7.avg_val = 0 THEN 0
            ELSE ROUND(((last7.avg_val - prev7.avg_val) / prev7.avg_val * 100)::numeric, 1)
          END AS trend_pct
        FROM last7, prev7
      `);

      const bestDayRow = bestDay.rows[0];
      const trendRow = trend.rows[0];

      res.json({
        total_visitors: Number(totalVisitors.rows[0].total),
        total_revenue: Number(totalRevenue.rows[0].total),
        best_day: bestDayRow ? bestDayRow.date : null,
        best_day_visitors: bestDayRow ? Number(bestDayRow.visitors) : 0,
        seven_day_trend: trendRow ? Number(trendRow.trend_pct) : 0,
      });
    } catch (err) {
      console.error("Error in /api/summary:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/timeseries
  app.get("/api/timeseries", async (_req, res) => {
    try {
      const result = await db.query(
        "SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC"
      );
      // Format dates as YYYY-MM-DD strings
      const rows = result.rows.map((r) => ({
        date: r.date,
        visitors: Number(r.visitors),
        revenue: Number(r.revenue),
      }));
      res.json(rows);
    } catch (err) {
      console.error("Error in /api/timeseries:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/categories
  app.get("/api/categories", async (_req, res) => {
    try {
      const result = await db.query(
        "SELECT id, name, value FROM categories ORDER BY value DESC"
      );
      const rows = result.rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        value: Number(r.value),
      }));
      res.json(rows);
    } catch (err) {
      console.error("Error in /api/categories:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/recent
  app.get("/api/recent", async (_req, res) => {
    try {
      const result = await db.query(
        "SELECT id, name, category, value, created_at FROM recent_items ORDER BY created_at DESC"
      );
      const rows = result.rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        category: r.category,
        value: Number(r.value),
        created_at: r.created_at,
      }));
      res.json(rows);
    } catch (err) {
      console.error("Error in /api/recent:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/settings
  app.get("/api/settings", async (_req, res) => {
    try {
      const result = await db.query(
        "SELECT key, value FROM settings WHERE key = 'theme'"
      );
      const theme = result.rows.length > 0 ? result.rows[0].value : "light";
      res.json({ theme });
    } catch (err) {
      console.error("Error in GET /api/settings:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /api/settings
  app.put("/api/settings", async (req, res) => {
    try {
      const { theme } = req.body;
      if (theme !== "light" && theme !== "dark") {
        return res.status(400).json({ error: "theme must be 'light' or 'dark'" });
      }
      await db.query(
        `INSERT INTO settings (key, value) VALUES ('theme', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [theme]
      );
      res.json({ theme });
    } catch (err) {
      console.error("Error in PUT /api/settings:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // SPA fallback
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
