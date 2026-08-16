import express from "express";
import cors from "cors";
import { getDb } from "./db.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Helper to safely coerce numeric values returned by PGLite (which may come
// back as strings for NUMERIC/BIGINT types).
function num(v) {
  return typeof v === "number" ? v : Number(v);
}

// GET /api/summary -> total visitors, total revenue, best day, 7-day trend %
app.get("/api/summary", async (req, res) => {
  try {
    const db = await getDb();
    const totals = await db.query(`
      SELECT
        COALESCE(SUM(visitors), 0)::bigint AS total_visitors,
        COALESCE(SUM(revenue), 0)::numeric AS total_revenue
      FROM daily_metrics;
    `);

    const best = await db.query(`
      SELECT date, visitors
      FROM daily_metrics
      ORDER BY visitors DESC, date DESC
      LIMIT 1;
    `);

    // 7-day trend %: sum of last 7 days vs the 7 days before that (by visitors)
    const ordered = await db.query(`
      SELECT visitors FROM daily_metrics ORDER BY date ASC;
    `);
    const visitorsArr = ordered.rows.map((r) => num(r.visitors));
    const n = visitorsArr.length;
    const last7 = visitorsArr.slice(Math.max(0, n - 7)).reduce((a, b) => a + b, 0);
    const prev7 = visitorsArr
      .slice(Math.max(0, n - 14), Math.max(0, n - 7))
      .reduce((a, b) => a + b, 0);
    let trendPct = 0;
    if (prev7 > 0) {
      trendPct = ((last7 - prev7) / prev7) * 100;
    }

    const bestRow = best.rows[0];
    res.json({
      totalVisitors: num(totals.rows[0].total_visitors),
      totalRevenue: num(totals.rows[0].total_revenue),
      bestDay: bestRow
        ? { date: bestRow.date, visitors: num(bestRow.visitors) }
        : null,
      trendPct: Math.round(trendPct * 10) / 10,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

// GET /api/timeseries -> 30-day series
app.get("/api/timeseries", async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT date, visitors, revenue
      FROM daily_metrics
      ORDER BY date ASC;
    `);
    res.json(
      result.rows.map((r) => ({
        date: r.date,
        visitors: num(r.visitors),
        revenue: num(r.revenue),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load timeseries" });
  }
});

// GET /api/categories -> category breakdown
app.get("/api/categories", async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT name, value FROM categories ORDER BY value DESC;
    `);
    res.json(
      result.rows.map((r) => ({ name: r.name, value: num(r.value) }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

// GET /api/recent -> recent items table
app.get("/api/recent", async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT name, category, value, created_at
      FROM recent_items
      ORDER BY created_at DESC;
    `);
    res.json(
      result.rows.map((r) => ({
        name: r.name,
        category: r.category,
        value: num(r.value),
        created_at: r.created_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load recent items" });
  }
});

// GET /api/settings -> { theme }
app.get("/api/settings", async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`SELECT theme FROM settings WHERE id = 1;`);
    const theme = result.rows[0]?.theme ?? "light";
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// PUT /api/settings -> persist { theme }
app.put("/api/settings", async (req, res) => {
  try {
    const { theme } = req.body || {};
    if (theme !== "light" && theme !== "dark") {
      return res
        .status(400)
        .json({ error: "theme must be 'light' or 'dark'" });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET theme = EXCLUDED.theme;`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Metrics dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
