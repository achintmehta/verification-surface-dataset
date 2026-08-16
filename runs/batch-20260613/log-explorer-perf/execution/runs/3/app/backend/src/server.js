import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { initSchema, vacuumAnalyze } from './schema.js';
import { seedIfNeeded } from './seed.js';
import logsRouter from './routes/logs.js';

const PORT = process.env.PORT || 3001;

/**
 * Warm up the query planner by running representative queries once.
 * This ensures the first real request doesn't pay the planning cost.
 */
async function warmupQueries(db) {
  console.log('[server] Warming up query planner...');
  const queries = [
    // No-filter queries at various offsets
    `SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 0`,
    `SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 50000`,
    `SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC LIMIT 100 OFFSET 99900`,
    // Severity filter queries
    `SELECT id, ts, severity, service, message FROM logs WHERE severity = 'debug' ORDER BY ts DESC LIMIT 100 OFFSET 0`,
    `SELECT id, ts, severity, service, message FROM logs WHERE severity = 'debug' ORDER BY ts DESC LIMIT 100 OFFSET 50000`,
    `SELECT id, ts, severity, service, message FROM logs WHERE severity = 'error' ORDER BY ts DESC LIMIT 100 OFFSET 0`,
    // Count queries
    `SELECT COUNT(*) FROM logs`,
    `SELECT COUNT(*) FROM logs WHERE severity = 'debug'`,
    // ILIKE query
    `SELECT id, ts, severity, service, message FROM logs WHERE message ILIKE '%request%' ORDER BY ts DESC LIMIT 100 OFFSET 0`,
    // Stats query
    `SELECT severity, COUNT(*) AS cnt FROM logs GROUP BY severity`,
  ];

  for (const sql of queries) {
    await db.query(sql);
  }
  console.log('[server] Warmup complete.');
}

async function main() {
  console.log('[server] Starting log-explorer backend...');
  const t0 = Date.now();

  // Initialize database
  const db = await getDb();
  console.log('[server] PGLite ready.');

  // Create schema (idempotent)
  await initSchema(db);

  // Seed if needed (skips if already seeded)
  const wasSeeded = await seedIfNeeded(db);

  // Run VACUUM ANALYZE after first seed to update statistics and visibility map
  // This ensures index-only scans work efficiently from the first query
  if (wasSeeded) {
    await vacuumAnalyze(db);
  }

  // Warm up the query planner so the first real request doesn't pay planning cost
  await warmupQueries(db);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[server] Boot complete in ${elapsed}s.`);

  // Set up Express
  const app = express();

  app.use(cors({
    origin: '*',
    methods: ['GET'],
  }));

  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // API routes
  app.use('/api', logsRouter);

  // 404 handler
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error during startup:', err);
  process.exit(1);
});
