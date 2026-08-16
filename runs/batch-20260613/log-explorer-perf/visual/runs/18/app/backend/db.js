const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function initDb() {
  const dbPath = path.join(__dirname, 'pglite-data');
  const db = new PGlite(dbPath);

  // Check if table exists
  const res = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'logs'
    );
  `);

  const exists = res.rows[0].exists;

  if (!exists) {
    console.log('Initializing database schema and seeding data...');
    await db.exec(`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMP NOT NULL,
        severity VARCHAR(10) NOT NULL,
        service VARCHAR(50) NOT NULL,
        message TEXT NOT NULL
      );
    `);

    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.exec(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    } catch (e) {
      console.warn('Could not create pg_trgm extension or index, substring search may be slower.', e.message);
    }

    await db.exec(`CREATE INDEX idx_logs_ts ON logs (ts DESC);`);
    await db.exec(`CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);`);

    // Seed 100,000 rows
    const totalRows = 100000;
    const batchSize = 5000;
    const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'shipping-service', 'notification-service'];
    
    // Distribution: 60% debug, 25% info, 10% warn, 5% error
    function getSeverity(i) {
      const r = (i * 137) % 100; // deterministic pseudo-random
      if (r < 60) return 'debug';
      if (r < 85) return 'info';
      if (r < 95) return 'warn';
      return 'error';
    }

    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment {id} processed for amount {amount}",
      "Order {id} created by user {user}",
      "Inventory low for item {item}",
      "Email sent to {email}",
      "Service {service} started",
      "Connection timeout to database",
      "Invalid payload received: {payload}",
      "Disk space critical on volume {volume}"
    ];

    function getMessage(i) {
      const tpl = templates[i % templates.length];
      return tpl
        .replace('{user}', 'user_' + (i % 1000))
        .replace('{id}', 'id_' + (i % 50000))
        .replace('{amount}', '$' + ((i % 100) + 10))
        .replace('{item}', 'item_' + (i % 500))
        .replace('{email}', 'user_' + (i % 1000) + '@example.com')
        .replace('{service}', services[i % services.length])
        .replace('{payload}', 'payload_' + (i % 10000))
        .replace('{volume}', 'vol_' + (i % 5));
    }

    const now = new Date('2023-01-01T00:00:00Z').getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (let batch = 0; batch < totalRows / batchSize; batch++) {
      let values = [];
      for (let i = 0; i < batchSize; i++) {
        const globalI = batch * batchSize + i;
        const ts = new Date(now + (globalI / totalRows) * thirtyDaysMs).toISOString();
        const severity = getSeverity(globalI);
        const service = services[globalI % services.length];
        const message = getMessage(globalI);
        
        // Escape single quotes
        const safeMessage = message.replace(/'/g, "''");
        values.push(`('${ts}', '${severity}', '${service}', '${safeMessage}')`);
      }
      
      const query = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`;
      await db.exec(query);
    }
    console.log('Seeding complete.');
  } else {
    console.log('Database already initialized.');
  }

  return db;
}

module.exports = { initDb };