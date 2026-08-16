import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { seedDatabase } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'logs.db');

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const MAX_LIMIT = 200;

async function main() {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log('Initializing PGLite database at', DB_PATH);
  const db = new PGlite(DB_PATH);

  // Initialize schema and seed
  await initSchema(db);
  await seedDatabase(db);

  const app = express();
  app.use(cors());
  app.use(express.json());

  /**
   * GET /api/logs
   * Query params:
   *   offset  (int, ≥0, default 0)
   *   limit   (int, 1–200, default 100)
   *   severity (debug|info|warn|error, optional)
   *   q       (substring search on message, optional)
   *
   * Returns: { total: number, rows: Row[] }
   * Rows ordered by ts DESC, id DESC.
   */
  app.get('/api/logs', async (req, res) => {
    try {
      const { offset: rawOffset, limit: rawLimit, severity, q } = req.query;

      // ── Validate offset ──────────────────────────────────────────────────────
      const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }

      // ── Validate limit ───────────────────────────────────────────────────────
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;
      if (!Number.isInteger(limit) || limit < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      if (limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit cannot exceed ${MAX_LIMIT}` });
      }

      // ── Validate severity ────────────────────────────────────────────────────
      if (severity !== undefined && severity !== '' && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({
          error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
        });
      }

      // ── Build WHERE clause ───────────────────────────────────────────────────
      const conditions = [];
      const params = [];
      let p = 1;

      if (severity) {
        conditions.push(`severity = $${p++}`);
        params.push(severity);
      }
      if (q) {
        conditions.push(`message ILIKE $${p++}`);
        params.push(`%${q}%`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      // ── Count ────────────────────────────────────────────────────────────────
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM logs ${where}`,
        params
      );
      const total = countRes.rows[0].total;

      // ── Data ─────────────────────────────────────────────────────────────────
      const dataRes = await db.query(
        `SELECT id, ts, severity, service, message
         FROM logs
         ${where}
         ORDER BY ts DESC, id DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, limit, offset]
      );

      return res.json({ total, rows: dataRes.rows });
    } catch (err) {
      console.error('GET /api/logs error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/stats
   * Returns: { total: number, bySeverity: { debug, info, warn, error } }
   */
  app.get('/api/stats', async (req, res) => {
    try {
      const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs');
      const sevRes = await db.query(
        `SELECT severity, COUNT(*)::int AS count
         FROM logs
         GROUP BY severity
         ORDER BY severity`
      );

      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      for (const row of sevRes.rows) {
        bySeverity[row.severity] = row.count;
      }

      return res.json({ total: totalRes.rows[0].total, bySeverity });
    } catch (err) {
      console.error('GET /api/stats error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Log Explorer API server running on http://localhost:${PORT}`);
  });
}

async function initSchema(db) {
  // Try pg_trgm for fast ILIKE substring search
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    console.log('pg_trgm extension enabled');
  } catch {
    console.log('pg_trgm not available — substring search uses sequential scan');
  }

  // Core table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service  TEXT NOT NULL,
      message  TEXT NOT NULL
    );
  `);

  // Index: ordering by ts (no filter) — covers the most common query shape
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts_id
      ON logs (ts DESC, id DESC);
  `);

  // Index: severity equality + ordering — covers severity-filtered queries
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_id
      ON logs (severity, ts DESC, id DESC);
  `);

  // Trigram index for fast ILIKE (if pg_trgm is available)
  try {
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING gin (message gin_trgm_ops);
    `);
    console.log('Trigram GIN index on message created');
  } catch {
    console.log('Trigram index not available — ILIKE will use sequential scan');
  }

  console.log('Schema initialized');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
