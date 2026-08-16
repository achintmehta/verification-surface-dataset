import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { seedIfNeeded } from './seed.js';

const PORT = process.env.PORT || 3001;
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  console.log('[server] Initializing database...');
  const bootStart = Date.now();
  const db = await getDb();
  await seedIfNeeded(db);
  console.log(`[server] Database ready in ${Date.now() - bootStart}ms`);

  // ─── GET /api/logs ─────────────────────────────────────────────────
  app.get('/api/logs', async (req, res) => {
    try {
      // Parse and validate parameters
      const offset = req.query.offset !== undefined ? parseInt(req.query.offset, 10) : 0;
      const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 50;
      const severity = req.query.severity || null;
      const q = req.query.q || null;

      // Validation
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
      if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
      }
      if (severity !== null && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

      // Build query
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

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countSql = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSql, params);
      const total = countResult.rows[0].total;

      // Get rows
      const rowParams = [...params, limit, offset];
      const dataSql = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      const dataResult = await db.query(dataSql, rowParams);

      res.json({
        total,
        rows: dataResult.rows,
      });
    } catch (err) {
      console.error('[api/logs] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── GET /api/stats ────────────────────────────────────────────────
  app.get('/api/stats', async (_req, res) => {
    try {
      const totalResult = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const severityResult = await db.query(
        `SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity ORDER BY severity`
      );

      const severityCounts = {};
      for (const row of severityResult.rows) {
        severityCounts[row.severity] = row.count;
      }

      res.json({
        total: totalResult.rows[0].total,
        severities: severityCounts,
      });
    } catch (err) {
      console.error('[api/stats] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
