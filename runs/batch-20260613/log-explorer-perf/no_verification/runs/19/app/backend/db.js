import { PGlite } from '@electric-sql/pglite';
import path from 'path';

const dbPath = path.resolve('./pglite-data');
let db;

export async function initDb() {
  db = new PGlite(dbPath);
  
  await db.query('SELECT 1');

  const res = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'logs'
    );
  `);
  
  const tableExists = res.rows[0].exists;
  let count = 0;
  if (tableExists) {
    const countRes = await db.query(`SELECT COUNT(*) as c FROM logs`);
    count = parseInt(countRes.rows[0].c, 10);
  }

  if (!tableExists || count < 100000) {
    console.log('Initializing and seeding database...');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);

    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);
    `);

    const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'shipping-service', 'notification-service'];
    const severities = ['debug', 'info', 'warn', 'error'];
    
    const getSeverity = (i) => {
      const r = i % 100;
      if (r < 60) return 'info';
      if (r < 85) return 'debug';
      if (r < 95) return 'warn';
      return 'error';
    };

    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment {id} processed for amount {amount}",
      "Order {id} created by user {user}",
      "Inventory low for item {item}",
      "Email sent to {email}",
      "Shipping updated for order {id}",
      "Notification delivered to {user}"
    ];

    const batchSize = 5000;
    let rows = [];
    const now = new Date('2023-01-30T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 100000; i++) {
      const ts = new Date(now - (100000 - i) * (thirtyDaysMs / 100000)).toISOString();
      const severity = getSeverity(i);
      const service = services[i % services.length];
      
      const template = templates[i % templates.length];
      const message = template
        .replace('{user}', `user_${i % 1000}`)
        .replace('{id}', `id_${i % 5000}`)
        .replace('{amount}', `$${(i % 100) + 10}.00`)
        .replace('{item}', `item_${i % 500}`)
        .replace('{email}', `user_${i % 1000}@example.com`);

      rows.push(`('${ts}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);

      if (rows.length === batchSize) {
        await db.exec(`
          INSERT INTO logs (ts, severity, service, message)
          VALUES ${rows.join(',')}
        `);
        rows = [];
        console.log(`Seeded ${i + 1} rows...`);
      }
    }
    console.log('Seeding complete.');
  } else {
    console.log('Database already seeded.');
  }
}

export async function queryLogs({ offset, limit, severity, q }) {
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

  const countQuery = `SELECT COUNT(*) as total FROM logs ${whereStr}`;
  const countRes = await db.query(countQuery, params);
  const total = parseInt(countRes.rows[0].total, 10);

  const rowsQuery = `
    SELECT id, ts, severity, service, message 
    FROM logs 
    ${whereStr} 
    ORDER BY ts DESC 
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;
  const rowsParams = [...params, limit, offset];
  const rowsRes = await db.query(rowsQuery, rowsParams);

  return {
    total,
    rows: rowsRes.rows
  };
}

export async function getStats() {
  const totalRes = await db.query(`SELECT COUNT(*) as total FROM logs`);
  const total = parseInt(totalRes.rows[0].total, 10);

  const sevRes = await db.query(`SELECT severity, COUNT(*) as count FROM logs GROUP BY severity`);
  const counts = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const row of sevRes.rows) {
    counts[row.severity] = parseInt(row.count, 10);
  }

  return { total, counts };
}
