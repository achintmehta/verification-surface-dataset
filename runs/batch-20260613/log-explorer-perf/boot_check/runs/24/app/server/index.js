const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const PORT = process.env.PORT || 3001;

async function main() {
  const startTime = Date.now();
  console.log('[boot] Starting log-explorer server...');

  const db = await initDB();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static frontend files in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];
  const MAX_LIMIT = 200;

  // GET /api/logs?offset=&limit=&severity=&q=
  app.get('/api/logs', async (req, res) => {
    try {
      let offset = parseInt(req.query.offset, 10);
      let limit = parseInt(req.query.limit, 10);
      const severity = req.query.severity || null;
      const q = req.query.q || null;

      // Default values
      if (isNaN(offset)) offset = 0;
      if (isNaN(limit)) limit = 50;

      // Validation
      if (offset < 0) {
        return res.status(400).json({ error: 'offset must be non-negative' });
      }
      if (limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be between 1 and ${MAX_LIMIT}` });
      }
      if (severity && !VALID_SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
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

      // Count query
      const countSQL = `SELECT COUNT(*)::int AS total FROM logs ${whereClause}`;
      const countResult = await db.query(countSQL, params);
      const total = countResult.rows[0].total;

      // Data query
      const dataParams = [...params, limit, offset];
      const dataSQL = `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      const dataResult = await db.query(dataSQL, dataParams);

      res.json({ total, rows: dataResult.rows });
    } catch (err) {
      console.error('[api/logs] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (req, res) => {
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
        severityCounts
      });
    } catch (err) {
      console.error('[api/stats] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.listen(PORT, () => {
    const elapsed = Date.now() - startTime;
    console.log(`[boot] Server ready on port ${PORT} in ${elapsed}ms`);
  });
}

main().catch(err => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
