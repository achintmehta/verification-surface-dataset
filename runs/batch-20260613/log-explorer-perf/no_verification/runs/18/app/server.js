import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./pglite-data');

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = [
  'auth-service', 'user-service', 'payment-service', 'email-service',
  'inventory-service', 'order-service', 'shipping-service', 'notification-service'
];

const TEMPLATES = [
  "User {user} logged in successfully",
  "Failed to authenticate user {user}",
  "Payment of {amount} processed for order {order}",
  "Order {order} shipped via {carrier}",
  "Inventory low for item {item}",
  "Email sent to {email}",
  "Database connection established",
  "Cache miss for key {key}",
  "Service {service} started",
  "Unhandled exception in {module}: {error}"
];

let seed = 12345;
function random() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

function getRandomInt(max) {
  return Math.floor(random() * max);
}

function generateMessage() {
  const template = TEMPLATES[getRandomInt(TEMPLATES.length)];
  return template
    .replace('{user}', \`user_\${getRandomInt(10000)}\`)
    .replace('{amount}', \`$\${(random() * 1000).toFixed(2)}\`)
    .replace('{order}', \`ORD-\${getRandomInt(100000)}\`)
    .replace('{carrier}', ['UPS', 'FedEx', 'USPS', 'DHL'][getRandomInt(4)])
    .replace('{item}', \`ITEM-\${getRandomInt(5000)}\`)
    .replace('{email}', \`user\${getRandomInt(1000)}@example.com\`)
    .replace('{key}', \`cache_\${getRandomInt(10000)}\`)
    .replace('{service}', SERVICES[getRandomInt(SERVICES.length)])
    .replace('{module}', ['auth', 'db', 'api', 'worker'][getRandomInt(4)])
    .replace('{error}', ['Timeout', 'Connection reset', 'Null pointer', 'Out of memory'][getRandomInt(4)]);
}

async function seedDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM logs;`);
  const count = parseInt(res.rows[0].count, 10);

  if (count >= 100000) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Seeding database...');
  await db.exec('BEGIN;');
  await db.exec('TRUNCATE TABLE logs RESTART IDENTITY;');

  const BATCH_SIZE = 5000;
  const TOTAL_ROWS = 100000;
  const START_TIME = new Date('2024-01-01T00:00:00Z').getTime(); // Fixed start time
  const TIME_STEP = (30 * 24 * 60 * 60 * 1000) / TOTAL_ROWS;

  for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
    let values = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      const rowIdx = i + j;
      const ts = new Date(START_TIME + rowIdx * TIME_STEP).toISOString();
      
      const rand = random();
      let severity = 'debug';
      if (rand > 0.95) severity = 'error';
      else if (rand > 0.85) severity = 'warn';
      else if (rand > 0.60) severity = 'info';

      const service = SERVICES[getRandomInt(SERVICES.length)];
      const message = generateMessage();

      const escapedMessage = message.replace(/'/g, "''");
      values.push(`('${ts}', '${severity}', '${service}', '${escapedMessage}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
  }

  await db.exec('COMMIT;');

  console.log('Creating indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs(severity, ts DESC);
  `);

  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    console.log('Created pg_trgm index.');
  } catch (e) {
    console.log('pg_trgm not available, skipping trigram index.', e.message);
  }

  console.log('Seeding complete.');
}

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    let whereClauses = [];
    let params = [];
    let paramIdx = 1;

    if (severity) {
      whereClauses.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }

    if (q) {
      whereClauses.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q}%`);
    }

    const whereStr = whereClauses.length > 0 ? \`WHERE \${whereClauses.join(' AND ')}\` : '';

    const countQuery = \`SELECT COUNT(*) as total FROM logs \${whereStr}\`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    const rowsQuery = \`
      SELECT id, ts, severity, service, message 
      FROM logs 
      \${whereStr} 
      ORDER BY ts DESC 
      LIMIT $\${paramIdx++} OFFSET $\${paramIdx++}
    \`;
    const rowsParams = [...params, limit, offset];
    const rowsRes = await db.query(rowsQuery, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(\`SELECT COUNT(*) as total FROM logs\`);
    const total = parseInt(totalRes.rows[0].total, 10);

    const sevRes = await db.query(\`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity\`);
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    sevRes.rows.forEach(row => {
      counts[row.severity] = parseInt(row.count, 10);
    });

    res.json({ total, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  await seedDatabase();
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
}

start();
