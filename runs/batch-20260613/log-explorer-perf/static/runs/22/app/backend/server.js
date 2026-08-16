const express = require("express");
const cors = require("cors");
const path = require("path");
const { getDb } = require("./db");
const { seed } = require("./seed");

const PORT = process.env.PORT || 3001;
const VALID_SEVERITIES = new Set(["debug", "info", "warn", "error"]);
const MAX_LIMIT = 200;

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve frontend static files in production
  const frontendDist = path.join(__dirname, "..", "frontend", "dist");
  app.use(express.static(frontendDist));

  console.log("[server] Initializing database...");
  const db = await getDb();
  const seedResult = await seed(db);
  console.log(`[server] DB ready (seeded=${seedResult.seeded}, ${seedResult.durationMs}ms)`);

  // ─── GET /api/logs ────────────────────────────────────────────────────
  app.get("/api/logs", async (req, res) => {
    try {
      // Parse & validate offset
      let offset = parseInt(req.query.offset, 10);
      if (isNaN(offset)) offset = 0;
      if (offset < 0) {
        return res.status(400).json({ error: "offset must be >= 0" });
      }

      // Parse & validate limit
      let limit = parseInt(req.query.limit, 10);
      if (isNaN(limit)) limit = 50;
      if (limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
      }

      // Validate severity
      const severity = req.query.severity || null;
      if (severity && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(", ")}` });
      }

      // Substring query
      const q = req.query.q || null;

      // Build WHERE clause
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (severity) {
        conditions.push(`severity = $${paramIdx++}`);
        params.push(severity);
      }
      if (q) {
        conditions.push(`message ILIKE $${paramIdx++}`);
        params.push(`%${q}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Count query
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, params);
      const total = countResult.rows[0].total;

      // Data query
      const dataParams = [...params, limit, offset];
      const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      const dataResult = await db.query(dataSql, dataParams);

      res.json({ total, rows: dataResult.rows });
    } catch (err) {
      console.error("[api/logs] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── GET /api/stats ───────────────────────────────────────────────────
  app.get("/api/stats", async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug,
          COUNT(*) FILTER (WHERE severity = 'info')::int  AS info,
          COUNT(*) FILTER (WHERE severity = 'warn')::int  AS warn,
          COUNT(*) FILTER (WHERE severity = 'error')::int AS error
        FROM logs
      `);
      res.json(result.rows[0]);
    } catch (err) {
      console.error("[api/stats] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // SPA fallback
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
