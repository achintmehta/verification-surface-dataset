const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
const db = new PGlite(dbPath);

const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'shipping-service', 'api-gateway'];

function getSeverity(rand) {
  if (rand < 60) return 'debug';
  if (rand < 85) return 'info';
  if (rand < 95) return 'warn';
  return 'error';
}

const templates = [
  "User {user_id} logged in successfully",
  "Failed to authenticate user {user_id}",
  "Payment {payment_id} processed for amount {amount}",
  "Order {order_id} created by user {user_id}",
  "Inventory updated for item {item_id}, new count {count}",
  "Email sent to {email}",
  "Shipping label generated for order {order_id}",
  "API request to {endpoint} took {ms}ms",
  "Database connection timeout on {db_host}",
  "Cache miss for key {cache_key}"
];

let seed = 12345;
function random() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}
function randomInt(min, max) {
  return Math.floor(random() * (max - min)) + min;
}

async function seedDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  const res = await db.query(`SELECT COUNT(*) as count FROM logs`);
  if (parseInt(res.rows[0].count) >= 100000) {
    console.log('Database already seeded');
    return;
  }

  console.log('Seeding database...');
  await db.exec(`TRUNCATE logs RESTART IDENTITY;`);

  const now = new Date('2023-10-01T00:00:00Z').getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const startTime = now - thirtyDaysMs;

  const batchSize = 5000;
  for (let i = 0; i < 100000; i += batchSize) {
    let values = [];
    for (let j = 0; j < batchSize; j++) {
      const id = i + j;
      const ts = new Date(startTime + (id * (thirtyDaysMs / 100000))).toISOString();
      const sev = getSeverity(randomInt(0, 100));
      const svc = services[randomInt(0, services.length)];
      const tpl = templates[randomInt(0, templates.length)];
      const msg = tpl
        .replace('{user_id}', randomInt(1, 10000))
        .replace('{payment_id}', randomInt(1000, 9999))
        .replace('{amount}', (random() * 100).toFixed(2))
        .replace('{order_id}', randomInt(10000, 99999))
        .replace('{item_id}', randomInt(1, 500))
        .replace('{count}', randomInt(0, 100))
        .replace('{email}', \`user\${randomInt(1, 1000)}@example.com\`)
        .replace('{endpoint}', ['/api/v1/users', '/api/v1/orders', '/api/v1/payments'][randomInt(0, 3)])
        .replace('{ms}', randomInt(10, 500))
        .replace('{db_host}', \`db-\${randomInt(1, 5)}.internal\`)
        .replace('{cache_key}', \`key_\${randomInt(1, 10000)}\`);
      
      values.push(`('${ts}', '${sev}', '${svc}', '${msg.replace(/'/g, "''")}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
  }

  console.log('Creating indexes...');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);
  
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);`);
  } catch (e) {
    console.log('pg_trgm not supported, skipping trigram index');
  }
  
  console.log('Seeding complete');
}

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset);
    limit = parseInt(limit);

    if (isNaN(offset) || offset < 0) return res.status(400).json({ error: 'Invalid offset' });
    if (isNaN(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'Invalid limit' });
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    let conditions = [];
    let params = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }
    if (q) {
      conditions.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q}%`);
    }

    let whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `SELECT COUNT(*) as total FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowsParams = [...params, limit, offset];
    const rowsRes = await db.query(rowsQuery, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as total FROM logs`);
    const sevRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity`);
    
    const counts = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0
    };
    
    sevRes.rows.forEach(row => {
      counts[row.severity] = parseInt(row.count);
    });
    
    res.json({
      total: parseInt(totalRes.rows[0].total),
      counts
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;

seedDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
