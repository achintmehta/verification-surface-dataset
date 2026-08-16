const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'pgdata');

async function main() {
  // Dynamic import for ESM module
  const { PGlite } = await import('@electric-sql/pglite');

  const db = new PGlite(DATA_DIR);

  // ── Schema & Seed ──────────────────────────────────────────────────────────

  // Check if already seeded
  const tableCheck = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'logs'
    ) AS exists
  `);
  const tableExists = tableCheck.rows[0].exists;

  let needsSeed = true;
  if (tableExists) {
    const countRes = await db.query('SELECT count(*)::int AS cnt FROM logs');
    if (countRes.rows[0].cnt >= 100000) {
      needsSeed = false;
      console.log('Table already seeded, skipping.');
    } else {
      // Table exists but incomplete – drop and reseed
      await db.query('DROP TABLE logs');
      console.log('Incomplete seed detected, re-seeding...');
    }
  }

  if (needsSeed) {
    console.log('Creating schema and seeding 100,000 rows...');
    const seedStart = Date.now();

    await db.query(`
      CREATE TABLE logs (
        id        SERIAL PRIMARY KEY,
        ts        TIMESTAMP NOT NULL,
        severity  TEXT      NOT NULL,
        service   TEXT      NOT NULL,
        message   TEXT      NOT NULL
      )
    `);

    // ── Deterministic seed data ────────────────────────────────────────────

    const SEVERITIES = ['debug', 'info', 'warn', 'error'];
    // Cumulative weights: debug 60%, info 25%, warn 10%, error 5%
    const SEV_CUM_WEIGHTS = [60, 85, 95, 100];

    const SERVICES = [
      'api-gateway', 'auth-service', 'user-service', 'order-service',
      'payment-service', 'inventory-service', 'notification-service', 'analytics-service'
    ];

    const MESSAGE_TEMPLATES = [
      'Request processed successfully in {duration}ms',
      'Connection to database {db} established',
      'Failed to connect to upstream service {service}',
      'Cache miss for key {key}, fetching from source',
      'Rate limit exceeded for client {client}',
      'Health check passed with status {status}',
      'Timeout waiting for response from {service} after {duration}ms',
      'User {user} authenticated via {method}',
      'Retry attempt {attempt} for operation {op}',
      'Configuration reloaded from {source}',
      'Memory usage at {pct}% of allocated heap',
      'Received {count} events in batch processing',
      'SSL certificate for {domain} expires in {days} days',
      'Query execution took {duration}ms on table {table}',
      'Deployment {version} rolled out to {pct}% of instances',
      'Invalid request payload from {client}: {reason}',
      'Circuit breaker opened for {service}',
      'Scheduled job {job} completed in {duration}ms',
      'Disk usage on volume {vol} is at {pct}%',
      'Incoming webhook from {source} with {count} items'
    ];

    const FRAGMENT_POOLS = {
      duration: ['12', '45', '99', '234', '567', '1023', '2500', '5001'],
      db: ['postgres-primary', 'postgres-replica', 'redis-cache', 'mongo-analytics'],
      service: ['auth-service', 'payment-service', 'order-service', 'inventory-service', 'notification-service'],
      key: ['user:1001', 'session:abc', 'product:42', 'config:main', 'cache:homepage'],
      client: ['mobile-app', 'web-frontend', 'partner-api', 'internal-cron', 'load-balancer'],
      status: ['healthy', 'degraded', 'recovering'],
      user: ['alice', 'bob', 'charlie', 'diana', 'system'],
      method: ['oauth2', 'api-key', 'jwt', 'session-cookie'],
      attempt: ['1', '2', '3', '4', '5'],
      op: ['send-email', 'charge-card', 'sync-inventory', 'generate-report'],
      source: ['consul', 'vault', 'env-file', 'config-server'],
      pct: ['25', '50', '72', '85', '93'],
      count: ['10', '50', '128', '500', '1024'],
      domain: ['api.example.com', 'auth.example.com', 'cdn.example.com'],
      days: ['7', '14', '30', '60', '90'],
      table: ['users', 'orders', 'products', 'sessions', 'events'],
      version: ['v1.2.3', 'v1.3.0', 'v2.0.0-rc1', 'v2.0.0'],
      reason: ['missing field', 'invalid format', 'schema violation', 'size exceeded'],
      job: ['cleanup-sessions', 'aggregate-metrics', 'send-digests', 'rotate-logs'],
      vol: ['/data', '/tmp', '/var/log', '/backups'],
      item: ['events', 'records', 'messages', 'tasks']
    };

    // Simple deterministic PRNG (mulberry32)
    function mulberry32(seed) {
      return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }

    const rng = mulberry32(42);

    function pickSeverity() {
      const r = Math.floor(rng() * 100);
      for (let i = 0; i < SEV_CUM_WEIGHTS.length; i++) {
        if (r < SEV_CUM_WEIGHTS[i]) return SEVERITIES[i];
      }
      return SEVERITIES[3];
    }

    function generateMessage() {
      const tmpl = MESSAGE_TEMPLATES[Math.floor(rng() * MESSAGE_TEMPLATES.length)];
      return tmpl.replace(/\{(\w+)\}/g, (_match, key) => {
        const pool = FRAGMENT_POOLS[key];
        if (!pool) return key;
        return pool[Math.floor(rng() * pool.length)];
      });
    }

    // Time range: last 30 days
    const END_TS = new Date('2025-06-10T00:00:00Z');
    const START_TS = new Date(END_TS.getTime() - 30 * 24 * 60 * 60 * 1000);
    const TIME_RANGE = END_TS.getTime() - START_TS.getTime();

    const TOTAL = 100000;
    const BATCH_SIZE = 2000;

    for (let batchStart = 0; batchStart < TOTAL; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL);
      const batchCount = batchEnd - batchStart;

      // Build a parameterised INSERT with $1..$N
      const valueClauses = [];
      const params = [];
      for (let i = 0; i < batchCount; i++) {
        const idx = batchStart + i;
        // Deterministic timestamp: evenly spaced with small jitter
        const baseTime = START_TS.getTime() + (idx / TOTAL) * TIME_RANGE;
        const jitter = Math.floor(rng() * 25000) - 12500; // ±12.5 s
        const ts = new Date(baseTime + jitter);

        const severity = pickSeverity();
        const service = SERVICES[Math.floor(rng() * SERVICES.length)];
        const message = generateMessage();

        const p = i * 4;
        valueClauses.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4})`);
        params.push(ts.toISOString(), severity, service, message);
      }

      await db.query(
        `INSERT INTO logs (ts, severity, service, message) VALUES ${valueClauses.join(',')}`,
        params
      );

      if ((batchStart + BATCH_SIZE) % 20000 === 0 || batchStart + BATCH_SIZE >= TOTAL) {
        console.log(`  Seeded ${Math.min(batchStart + BATCH_SIZE, TOTAL)} / ${TOTAL}`);
      }
    }

    // ── Indexes ──────────────────────────────────────────────────────────────
    console.log('Creating indexes...');

    await db.query('CREATE INDEX idx_logs_ts ON logs (ts DESC)');
    await db.query('CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC)');
    // pg_trgm for fast ILIKE; PGlite may or may not support the extension.
    // Use a B-tree on lower(message) for prefix and a GIN trigram if available.
    try {
      await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await db.query("CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops)");
      console.log('Created trigram index for message search.');
    } catch (_e) {
      console.log('pg_trgm not available; substring search will use sequential scan with index on (severity, ts).');
    }

    const seedDuration = ((Date.now() - seedStart) / 1000).toFixed(1);
    console.log(`Seeding complete in ${seedDuration}s.`);
  }

  // ── Express app ──────────────────────────────────────────────────────────

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static frontend files from client/dist if it exists
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
  }

  const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
  const MAX_LIMIT = 200;

  // GET /api/logs?offset=&limit=&severity=&q=
  app.get('/api/logs', async (req, res) => {
    try {
      let offset = parseInt(req.query.offset, 10);
      let limit = parseInt(req.query.limit, 10);
      const severity = req.query.severity || null;
      const q = req.query.q || null;

      // Defaults
      if (isNaN(offset)) offset = 0;
      if (isNaN(limit)) limit = 50;

      // Validation
      if (offset < 0) return res.status(400).json({ error: 'offset must be >= 0' });
      if (limit < 1 || limit > MAX_LIMIT) return res.status(400).json({ error: `limit must be 1-${MAX_LIMIT}` });
      if (severity !== null && !VALID_SEVERITIES.has(severity)) {
        return res.status(400).json({ error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}` });
      }

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
      const countRes = await db.query(
        `SELECT count(*)::int AS total FROM logs ${whereClause}`,
        params
      );
      const total = countRes.rows[0].total;

      // Data query
      const dataParams = [...params, limit, offset];
      const dataRes = await db.query(
        `SELECT id, ts, severity, service, message FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        dataParams
      );

      res.json({ total, rows: dataRes.rows });
    } catch (err) {
      console.error('Query error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/stats
  app.get('/api/stats', async (_req, res) => {
    try {
      const totalRes = await db.query('SELECT count(*)::int AS total FROM logs');
      const sevRes = await db.query(
        "SELECT severity, count(*)::int AS count FROM logs GROUP BY severity ORDER BY severity"
      );

      const bySeverity = {};
      for (const row of sevRes.rows) {
        bySeverity[row.severity] = row.count;
      }

      res.json({
        total: totalRes.rows[0].total,
        bySeverity
      });
    } catch (err) {
      console.error('Stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Fallback for SPA
  if (fs.existsSync(clientDist)) {
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Log Explorer server listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
