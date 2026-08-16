const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'pglite-data');

async function initDb() {
  const db = new PGlite(DB_PATH);

  const checkRes = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'logs'
    );
  `);

  const exists = checkRes.rows[0].exists;

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

    await db.exec(`
      CREATE INDEX idx_logs_ts ON logs(ts DESC);
      CREATE INDEX idx_logs_severity_ts ON logs(severity, ts DESC);
    `);

    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
      await db.exec(`CREATE INDEX idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    } catch (e) {
      console.log('pg_trgm not available, skipping trigram index');
    }

    const severities = ['debug', 'info', 'warn', 'error'];
    const sevWeights = [60, 25, 10, 5];
    const sevDistribution = [];
    for (let i = 0; i < severities.length; i++) {
      for (let j = 0; j < sevWeights[i]; j++) {
        sevDistribution.push(severities[i]);
      }
    }

    const services = ['auth-service', 'payment-gateway', 'user-profile', 'search-engine', 'recommendation', 'notification', 'billing', 'inventory'];
    const templates = [
      "User {user} logged in successfully",
      "Failed to authenticate user {user}",
      "Payment of {amount} processed for account {account}",
      "Insufficient funds for account {account}",
      "Search query '{query}' returned {count} results",
      "Timeout while calling {service}",
      "Disk usage at {percent}% on volume {volume}",
      "Cache miss for key {key}",
      "Sending email to {email}",
      "Failed to send SMS to {phone}"
    ];

    let seed = 12345;
    function random() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    function getRandomInt(min, max) {
      return Math.floor(random() * (max - min)) + min;
    }

    function getRandomItem(arr) {
      return arr[getRandomInt(0, arr.length)];
    }

    const BATCH_SIZE = 5000;
    const TOTAL_ROWS = 100000;
    const START_TIME = new Date('2023-01-01T00:00:00Z').getTime();
    const END_TIME = new Date('2023-01-31T00:00:00Z').getTime();

    for (let i = 0; i < TOTAL_ROWS; i += BATCH_SIZE) {
      let values = [];
      for (let j = 0; j < BATCH_SIZE; j++) {
        const ts = new Date(START_TIME + random() * (END_TIME - START_TIME)).toISOString();
        const severity = getRandomItem(sevDistribution);
        const service = getRandomItem(services);
        
        const template = getRandomItem(templates);
        let message = template
          .replace('{user}', \`user_\${getRandomInt(1, 10000)}\`)
          .replace('{amount}', \`$\${(random() * 1000).toFixed(2)}\`)
          .replace('{account}', \`acc_\${getRandomInt(1, 10000)}\`)
          .replace('{query}', getRandomItem(['shoes', 'electronics', 'books', 'clothing', 'home']))
          .replace('{count}', getRandomInt(0, 100))
          .replace('{service}', getRandomItem(services))
          .replace('{percent}', getRandomInt(80, 100))
          .replace('{volume}', \`/dev/sd\${getRandomItem(['a', 'b', 'c'])}\`)
          .replace('{key}', \`key_\${getRandomInt(1, 100000)}\`)
          .replace('{email}', \`user_\${getRandomInt(1, 10000)}@example.com\`)
          .replace('{phone}', \`+1555\${getRandomInt(1000000, 9999999)}\`);

        message = message.replace(/'/g, "''");
        
        values.push(\`('\${ts}', '\${severity}', '\${service}', '\${message}')\`);
      }
      
      await db.exec(\`
        INSERT INTO logs (ts, severity, service, message)
        VALUES \${values.join(', ')}
      \`);
      console.log(\`Inserted \${i + BATCH_SIZE} / \${TOTAL_ROWS} rows\`);
    }
    console.log('Seeding complete.');
  } else {
    console.log('Database already initialized.');
  }

  return db;
}

module.exports = { initDb };
