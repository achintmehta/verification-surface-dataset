const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
let db;

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SERVICES = [
  'auth-service', 'billing-service', 'api-gateway', 'user-service',
  'inventory-service', 'notification-service', 'search-service', 'analytics-service'
];

const MESSAGES = [
  "User {user_id} logged in successfully",
  "Failed to authenticate user {user_id}",
  "Payment processed for account {account_id}",
  "Insufficient funds for account {account_id}",
  "API rate limit exceeded for IP {ip}",
  "Cache miss for key {key}",
  "Database connection timeout",
  "Service {service} is restarting",
  "Disk space running low on volume {volume}",
  "Successfully indexed {count} documents",
  "Query took {time}ms to execute",
  "Invalid payload received from client {client_id}"
];

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateMessage() {
  const template = MESSAGES[getRandomInt(0, MESSAGES.length - 1)];
  return template
    .replace('{user_id}', getRandomInt(1000, 9999))
    .replace('{account_id}', getRandomInt(10000, 99999))
    .replace('{ip}', `192.168.1.${getRandomInt(1, 255)}`)
    .replace('{key}', `session_${getRandomInt(100, 999)}`)
    .replace('{service}', SERVICES[getRandomInt(0, SERVICES.length - 1)])
    .replace('{volume}', `/dev/sda${getRandomInt(1, 5)}`)
    .replace('{count}', getRandomInt(10, 10000))
    .replace('{time}', getRandomInt(1, 5000))
    .replace('{client_id}', `client_${getRandomInt(1, 100)}`);
}

function getSeverity() {
  const r = Math.random();
  if (r < 0.60) return 'debug';
  if (r < 0.85) return 'info';
  if (r < 0.95) return 'warn';
  return 'error';
}

async function seedDatabase() {
  console.log("Checking if database needs seeding...");
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
    console.log("Database already seeded.");
    return;
  }

  console.log("Seeding database with 100,000 rows...");
  await db.exec("BEGIN;");
  
  const totalRows = 100000;
  const batchSize = 1000;
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const startTime = now - thirtyDaysMs;

  // Deterministic random seed replacement for consistent generation
  let seed = 123456789;
  function pseudoRandom() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  
  function getPseudoRandomInt(min, max) {
    return Math.floor(pseudoRandom() * (max - min + 1)) + min;
  }

  function getPseudoSeverity() {
    const r = pseudoRandom();
    if (r < 0.60) return 'debug';
    if (r < 0.85) return 'info';
    if (r < 0.95) return 'warn';
    return 'error';
  }

  function generatePseudoMessage() {
    const template = MESSAGES[getPseudoRandomInt(0, MESSAGES.length - 1)];
    return template
      .replace('{user_id}', getPseudoRandomInt(1000, 9999))
      .replace('{account_id}', getPseudoRandomInt(10000, 99999))
      .replace('{ip}', `192.168.1.${getPseudoRandomInt(1, 255)}`)
      .replace('{key}', `session_${getPseudoRandomInt(100, 999)}`)
      .replace('{service}', SERVICES[getPseudoRandomInt(0, SERVICES.length - 1)])
      .replace('{volume}', `/dev/sda${getPseudoRandomInt(1, 5)}`)
      .replace('{count}', getPseudoRandomInt(10, 10000))
      .replace('{time}', getPseudoRandomInt(1, 5000))
      .replace('{client_id}', `client_${getPseudoRandomInt(1, 100)}`);
  }

  for (let i = 0; i < totalRows; i += batchSize) {
    let values = [];
    for (let j = 0; j < batchSize; j++) {
      const rowIdx = i + j;
      // Spread timestamps evenly over 30 days
      const tsMs = startTime + (thirtyDaysMs * (rowIdx / totalRows));
      const ts = new Date(tsMs).toISOString();
      const severity = getPseudoSeverity();
      const service = SERVICES[getPseudoRandomInt(0, SERVICES.length - 1)];
      const message = generatePseudoMessage().replace(/'/g, "''");
      values.push(`('${ts}', '${severity}', '${service}', '${message}')`);
    }
    await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
  }

  await db.exec("COMMIT;");
  console.log("Seeding complete.");

  console.log("Creating indexes...");
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
  } catch (e) {
    console.log("pg_trgm not available, skipping trigram index.");
  }
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  console.log("Indexes created.");
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as count FROM logs;`);
    const severityRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity;`);
    
    const stats = {
      total: parseInt(totalRes.rows[0].count, 10),
      severities: {}
    };
    
    severityRes.rows.forEach(row => {
      stats.severities[row.severity] = parseInt(row.count, 10);
    });
    
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

    // Get total count and rows in parallel
    const countQuery = `SELECT COUNT(*) as count FROM logs ${whereClause}`;
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereClause} 
      ORDER BY ts DESC 
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const rowsParams = [...params, limit, offset];
    
    const [countRes, rowsRes] = await Promise.all([
      db.query(countQuery, params),
      db.query(rowsQuery, rowsParams)
    ]);
    
    const total = parseInt(countRes.rows[0].count, 10);

    res.json({
      total,
      rows: rowsRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  db = new PGlite(dbPath);
  await db.waitReady;
  await seedDatabase();
  
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
  });
}

start().catch(console.error);
