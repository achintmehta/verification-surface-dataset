const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
let db;

const SEED_COUNT = 100000;

async function initDB() {
  db = new PGlite(dbPath);
  await db.waitReady;

  // Create table
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL,
      severity VARCHAR(10) NOT NULL,
      service VARCHAR(50) NOT NULL,
      message TEXT NOT NULL
    );
  `);

  // Check if seeded
  const res = await db.query(`SELECT COUNT(*) as count FROM logs;`);
  const count = parseInt(res.rows[0].count, 10);

  if (count === 0) {
    console.log('Seeding database...');
    const start = Date.now();
    
    const services = ['auth-service', 'billing-service', 'api-gateway', 'user-service', 'notification-service', 'search-service', 'inventory-service', 'payment-service'];
    const severities = ['debug', 'info', 'warn', 'error'];
    
    // 60% debug, 25% info, 10% warn, 5% error
    function getSeverity(i) {
      const r = (i * 997) % 100; // deterministic pseudo-random
      if (r < 60) return 'debug';
      if (r < 85) return 'info';
      if (r < 95) return 'warn';
      return 'error';
    }

    function getService(i) {
      return services[(i * 1009) % services.length];
    }

    const templates = [
      "User {user_id} logged in successfully",
      "Failed to authenticate user {user_id}",
      "Processing payment for order {order_id}",
      "Payment declined for order {order_id}",
      "Sending email to {email}",
      "Email delivery failed for {email}",
      "Searching for {query} in category {category}",
      "Item {item_id} out of stock",
      "Cache miss for key {key}",
      "Database connection timeout"
    ];

    function getMessage(i) {
      const template = templates[(i * 1013) % templates.length];
      return template
        .replace('{user_id}', 'usr_' + ((i * 1019) % 10000))
        .replace('{order_id}', 'ord_' + ((i * 1021) % 50000))
        .replace('{email}', 'user' + ((i * 1031) % 10000) + '@example.com')
        .replace('{query}', 'term_' + ((i * 1033) % 500))
        .replace('{category}', 'cat_' + ((i * 1039) % 20))
        .replace('{item_id}', 'itm_' + ((i * 1049) % 20000))
        .replace('{key}', 'key_' + ((i * 1051) % 100000));
    }

    // 30 days span
    const now = new Date('2024-01-31T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    
    const batchSize = 5000;
    for (let i = 0; i < SEED_COUNT; i += batchSize) {
      const values = [];
      for (let j = 0; j < batchSize; j++) {
        const idx = i + j;
        // deterministic timestamp, spread across 30 days
        const ts = new Date(now - thirtyDaysMs + (idx * (thirtyDaysMs / SEED_COUNT))).toISOString();
        const severity = getSeverity(idx);
        const service = getService(idx);
        const message = getMessage(idx);
        
        // Escape single quotes in message
        const escapedMessage = message.replace(/'/g, "''");
        values.push(`('${ts}', '${severity}', '${service}', '${escapedMessage}')`);
      }
      
      await db.query(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')}
      `);
    }
    
    console.log(`Seeding completed in ${Date.now() - start}ms`);
  }

  // Create indexes
  console.log('Creating indexes...');
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts_asc ON logs (severity, ts ASC);`);
  
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
  } catch (e) {
    console.log('pg_trgm not supported, falling back to no trigram index', e.message);
  }
  
  console.log('Database ready');
}

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query(`SELECT COUNT(*) as count FROM logs;`);
    const total = parseInt(totalRes.rows[0].count, 10);
    
    const sevRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity;`);
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of sevRes.rows) {
      counts[row.severity] = parseInt(row.count, 10);
    }
    
    res.json({ total, counts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const countCache = new Map();

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);
    
    if (isNaN(offset) || offset < 0) return res.status(400).json({ error: 'Invalid offset' });
    if (isNaN(limit) || limit < 0 || limit > 200) return res.status(400).json({ error: 'Invalid limit' });
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
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
    
    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    
    // Get total
    const cacheKey = `${severity || ''}|${q || ''}`;
    let total;
    if (countCache.has(cacheKey)) {
      total = countCache.get(cacheKey);
    } else {
      const countQuery = `SELECT COUNT(*) as count FROM logs ${whereStr}`;
      const countRes = await db.query(countQuery, params);
      total = parseInt(countRes.rows[0].count, 10);
      countCache.set(cacheKey, total);
    }
    
    if (total === 0) {
      return res.json({ total: 0, rows: [] });
    }

    let queryOrder = 'DESC';
    let queryOffset = offset;
    let queryLimit = limit;
    let reverseResults = false;

    if (offset > total / 2) {
      queryOrder = 'ASC';
      queryOffset = total - offset - limit;
      if (queryOffset < 0) {
        queryLimit += queryOffset;
        queryOffset = 0;
      }
      reverseResults = true;
    }

    if (queryLimit <= 0) {
      return res.json({ total, rows: [] });
    }

    // Get rows
    const rowsQuery = `
      SELECT id, ts, severity, service, message 
      FROM logs 
      ${whereStr} 
      ORDER BY ts ${queryOrder} 
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const rowsParams = [...params, queryLimit, queryOffset];
    
    await db.query('BEGIN');
    await db.query('SET LOCAL enable_bitmapscan = off');
    await db.query('SET LOCAL enable_seqscan = off');
    let rowsRes;
    try {
      rowsRes = await db.query(rowsQuery, rowsParams);
    } catch (e) {
      // If it fails because no index can be used (e.g. substring search without trigram), fallback
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      rowsRes = await db.query(rowsQuery, rowsParams);
    }
    await db.query('COMMIT');
    
    let rows = rowsRes.rows;
    if (reverseResults) {
      rows.reverse();
    }
    
    res.json({ total, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
