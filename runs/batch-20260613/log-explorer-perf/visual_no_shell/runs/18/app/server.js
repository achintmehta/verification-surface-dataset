import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite('./pglite-data');

async function initDB() {
  await db.waitReady;
  
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
  const res = await db.query(`SELECT count(*) as count FROM logs;`);
  const count = parseInt(res.rows[0].count, 10);

  if (count === 0) {
    console.log('Seeding database with 100,000 rows...');
    const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'shipping-service', 'notification-service'];
    const severities = ['debug', 'info', 'warn', 'error'];
    
    // 60/25/10/5 distribution
    function getSeverity(i) {
      const r = (i * 997) % 100; // deterministic pseudo-random
      if (r < 60) return 'debug';
      if (r < 85) return 'info';
      if (r < 95) return 'warn';
      return 'error';
    }

    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment {id} processed for amount {amount}",
      "Insufficient funds for payment {id}",
      "Email sent to {email}",
      "Failed to send email to {email}",
      "Inventory updated for item {item}",
      "Item {item} is out of stock",
      "Order {id} created by user {user}",
      "Order {id} cancelled",
      "Shipment {id} dispatched",
      "Shipment {id} delayed",
      "Notification sent to user {user}",
      "Failed to send notification to user {user}",
      "Database connection established",
      "Database connection lost",
      "Cache miss for key {key}",
      "Cache hit for key {key}",
      "API request to {endpoint} took {time}ms",
      "API request to {endpoint} failed with status {status}"
    ];

    const users = ['alice', 'bob', 'charlie', 'dave', 'eve', 'frank', 'grace', 'heidi'];
    const items = ['laptop', 'phone', 'tablet', 'monitor', 'keyboard', 'mouse', 'printer', 'router'];
    const endpoints = ['/api/users', '/api/payments', '/api/orders', '/api/inventory', '/api/auth'];

    function getMessage(i) {
      const template = templates[(i * 1009) % templates.length];
      return template
        .replace('{user}', users[(i * 1013) % users.length])
        .replace('{id}', 1000 + (i % 9000))
        .replace('{amount}', '$' + ((i * 1019) % 1000) + '.00')
        .replace('{email}', users[(i * 1021) % users.length] + '@example.com')
        .replace('{item}', items[(i * 1031) % items.length])
        .replace('{key}', 'key_' + (i % 100))
        .replace('{endpoint}', endpoints[(i * 1033) % endpoints.length])
        .replace('{time}', (i * 1039) % 500)
        .replace('{status}', (i % 2 === 0) ? 500 : 403);
    }

    const BATCH_SIZE = 5000;
    const TOTAL_ROWS = 100000;
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const startTime = now - thirtyDaysMs;

    for (let batch = 0; batch < TOTAL_ROWS / BATCH_SIZE; batch++) {
      let values = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const globalI = batch * BATCH_SIZE + i;
        const ts = new Date(startTime + (globalI / TOTAL_ROWS) * thirtyDaysMs).toISOString();
        const severity = getSeverity(globalI);
        const service = services[(globalI * 1049) % services.length];
        const message = getMessage(globalI);
        
        // Escape single quotes in message
        const escapedMessage = message.replace(/'/g, "''");
        values.push(`('${ts}', '${severity}', '${service}', '${escapedMessage}')`);
      }
      
      await db.query(`
        INSERT INTO logs (ts, severity, service, message)
        VALUES ${values.join(', ')}
      `);
    }
    console.log('Seeding complete.');
  }

  console.log('Creating indexes...');
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
  console.log('Database ready.');
}

initDB().catch(console.error);

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit (must be 1-200)' });
    }
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

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Get total count
    const countQuery = `SELECT count(*) as total FROM logs ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].total, 10);

    // Get rows
    let rowsQuery;
    let rowsParams;
    
    if (offset > total / 2) {
      // For deep offsets, we can use a backward scan from the end
      const reverseOffset = total - offset - limit;
      if (reverseOffset >= 0) {
        rowsQuery = `
          SELECT * FROM (
            SELECT id, ts, severity, service, message 
            FROM logs 
            ${whereClause}
            ORDER BY ts ASC 
            LIMIT $${paramIdx++} OFFSET $${paramIdx++}
          ) sub
          ORDER BY ts DESC
        `;
        rowsParams = [...params, limit, reverseOffset];
      } else {
        // Edge case where offset + limit > total
        const adjustedLimit = total - offset;
        rowsQuery = `
          SELECT * FROM (
            SELECT id, ts, severity, service, message 
            FROM logs 
            ${whereClause}
            ORDER BY ts ASC 
            LIMIT $${paramIdx++} OFFSET 0
          ) sub
          ORDER BY ts DESC
        `;
        rowsParams = [...params, adjustedLimit];
      }
    } else {
      rowsQuery = `
        SELECT id, ts, severity, service, message 
        FROM logs 
        ${whereClause} 
        ORDER BY ts DESC 
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      `;
      rowsParams = [...params, limit, offset];
    }

    const rowsRes = await db.query(rowsQuery, rowsParams);

    res.json({ total, rows: rowsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT count(*) as total FROM logs');
    const total = parseInt(totalRes.rows[0].total, 10);

    const severityRes = await db.query('SELECT severity, count(*) as count FROM logs GROUP BY severity');
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of severityRes.rows) {
      counts[row.severity] = parseInt(row.count, 10);
    }

    res.json({ total, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/test', async (req, res) => {
  res.send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
