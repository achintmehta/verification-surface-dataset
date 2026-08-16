import { Router } from "express";
import { getDb } from "./db.js";

const router = Router();

const VALID_SEVERITIES = new Set(["debug", "info", "warn", "error"]);
const MAX_LIMIT = 200;

// ── GET /api/logs ────────────────────────────────────────────────────────────
router.get("/logs", async (req, res) => {
  try {
    const db = await getDb();

    // Parse and validate offset
    let offset = parseInt(req.query.offset, 10);
    if (req.query.offset !== undefined && (isNaN(offset) || offset < 0)) {
      return res.status(400).json({ error: "offset must be a non-negative integer" });
    }
    if (isNaN(offset)) offset = 0;

    // Parse and validate limit
    let limit = parseInt(req.query.limit, 10);
    if (req.query.limit !== undefined && (isNaN(limit) || limit < 1)) {
      return res.status(400).json({ error: "limit must be a positive integer" });
    }
    if (isNaN(limit)) limit = 50;
    if (limit > MAX_LIMIT) {
      return res.status(400).json({ error: `limit exceeds maximum of ${MAX_LIMIT}` });
    }

    // Parse and validate severity
    const severity = req.query.severity ? req.query.severity.toLowerCase() : null;
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: `unknown severity: ${severity}. Valid: debug, info, warn, error` });
    }

    // Parse q (search substring)
    const q = req.query.q || null;

    // Build query
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx}`);
      params.push(severity);
      paramIdx++;
    }

    if (q) {
      conditions.push(`message ILIKE $${paramIdx}`);
      params.push(`%${q}%`);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countQuery = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0].total;

    // Get rows
    const dataQuery = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    const dataParams = [...params, limit, offset];
    const dataResult = await db.query(dataQuery, dataParams);

    res.json({
      total,
      rows: dataResult.rows,
    });
  } catch (err) {
    console.error("Error querying logs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/stats ───────────────────────────────────────────────────────────
router.get("/stats", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'debug')::int AS debug,
        COUNT(*) FILTER (WHERE severity = 'info')::int AS info,
        COUNT(*) FILTER (WHERE severity = 'warn')::int AS warn,
        COUNT(*) FILTER (WHERE severity = 'error')::int AS error
      FROM logs
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error querying stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
