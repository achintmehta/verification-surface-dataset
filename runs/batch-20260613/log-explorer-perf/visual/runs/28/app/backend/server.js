const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, '.pglite');
let db = null;

const SERVICES = ['auth', 'payment', 'user', 'order', 'inventory', 'notification', 'analytics', 'gateway'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_WEIGHTS = [0.60, 0.25, 0.10, 0.05];
const MESSAGE_TEMPLATES = [
  'User {id} logged in from {ip}',
  'Payment {amount} processed for order {oid}',
  'Request to {endpoint} failed with code {code}',
  'Cache miss for key {key} in service {svc}',
  'Database query took {ms}ms on table {table}',
  'Sent notification to user {uid} via {channel}',
  'Inventory updated: {delta} units of {item}',
  'Analytics event {event} recorded for {user}'
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getSeverity(rand) {
  let cum = 0;
  for (let i = 0; i < SEVERITIES.length; i++) {
    cum += SEVERITY_WEIGHTS[i];
    if (rand < cum) return SEVERITIES[i];
  }
  return 'debug';
}

function generateMessage(rand1, rand2, rand3) {
  const tpl = MESSAGE_TEMPLATES[Math.floor(rand1 * MESSAGE_TEMPLATES.length)];
  return tpl
    .replace('{id}', Math.floor(rand2 * 100000))
    .replace('{ip}', `192.168.${Math.floor(rand3*255)}.${Math.floor(rand2*255)}`)
    .replace('{amount}', (rand1 * 1000).toFixed(2))
    .replace('{oid}', Math.floor(rand2 * 999999))
    .replace('{code}', 400 + Math.floor(rand3 * 100))
    .replace('{key}', 'cache_' + Math.floor(rand1 * 10000))
    .replace('{svc}', SERVICES[Math.floor(rand2 * SERVICES.length)])
    .replace('{ms}', Math.floor(rand3 * 500))
    .replace('{table}', ['users', 'orders', 'logs'][Math.floor(rand1*3)])
    .replace('{uid}', Math.floor(rand2 * 50000))
    .replace('{channel}', ['email', 'sms', 'push'][Math.floor(rand3*3)])
    .replace('{delta}', Math.floor(rand1 * 100) - 50)
    .replace('{item}', ['widget', 'gadget', 'tool'][Math.floor(rand2*3)])
    .replace('{event}', ['click', 'view', 'purchase'][Math.floor(rand3*3)])
    .replace('{user}', 'user_' + Math.floor(rand1 * 100000));
}

async function seedDatabase() {
  console.log('Seeding 100,000 log entries...');
  const startTime = Date.now();
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 5000;
  const START_TS = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);

  let seed = 42;
  for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = 0; i < BATCH_SIZE; i++) {
      const rowIdx = batch * BATCH_SIZE + i;
      seed++;
      const r1 = seededRandom(seed);
      seed++;
      const r2 = seededRandom(seed);
      seed++;
      const r3 = seededRandom(seed);
      seed++;
      const r4 = seededRandom(seed);

      const ts = new Date(START_TS + (rowIdx / TOTAL_ROWS) * 30 * 24 * 60 * 60 * 1000 + (r4 - 0.5) * 10000);
      const severity = getSeverity(r1);
      const service = SERVICES[Math.floor(r2 * SERVICES.length)];
      const message = generateMessage(r1, r2, r3);

      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(ts.toISOString(), severity, service, message);
    }

    const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(query, params);
    if (batch % 4 === 0) {
      console.log(`Seeded ${(batch + 1) * BATCH_SIZE} rows...`);
    }
  }
  console.log(`Seeding completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

async function initDatabase() {
  console.log('Initializing PGLite...');
  db = new PGlite({ dataDir: DATA_DIR });
  await db.waitReady;

  try {
    const countRes = await db.query('SELECT COUNT(*) as count FROM logs');
    const count = parseInt(countRes.rows[0].count);
    if (count >= 100000) {
      console.log(`Database already seeded with ${count} rows. Skipping seed.`);
      return;
    }
    if (count > 0) {
      console.log(`Partial data detected (${count} rows), reseeding...`);
      await db.exec('DROP TABLE IF EXISTS logs');
    }
  } catch (e) {
    // table not exist
  }

  await seedDatabase();
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as total FROM logs');
    const total = parseInt(totalRes.rows[0].total);

    const sevRes = await db.query(`
      SELECT severity, COUNT(*) as count 
      FROM logs 
      GROUP BY severity
    `);
    const perSeverity = {};
    SEVERITIES.forEach(s => perSeverity[s] = 0);
    sevRes.rows.forEach(r => {
      perSeverity[r.severity] = parseInt(r.count);
    });

    res.json({ total, perSeverity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = '0', limit = '100', severity, q } = req.query;
    const off = parseInt(offset, 10);
    let lim = parseInt(limit, 10);

    if (isNaN(off) || off < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
    if (isNaN(lim) || lim < 1) lim = 100;
    lim = Math.min(lim, 200);

    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    let whereClauses = [];
    let params = [];
    let idx = 1;

    if (severity) {
      whereClauses.push(`severity = $${idx++}`);
      params.push(severity);
    }
    if (q && q.trim()) {
      whereClauses.push(`message ILIKE $${idx++}`);
      params.push(`%${q.trim()}%`);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countQuery = `SELECT COUNT(*) as total FROM logs ${where}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    const dataParams = [...params, lim, off];
    const dataQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${where} 
      ORDER BY ts DESC, id DESC 
      LIMIT $${idx++} OFFSET $${idx}
    `;
    const dataRes = await db.query(dataQuery, dataParams);

    res.json({ total, rows: dataRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);