const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pgdata');
let db;

// Deterministic random generator
function mulberry32(a) {
    return function() {
      var t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

const rand = mulberry32(12345);

const severities = [
    { level: 'debug', weight: 60 },
    { level: 'info', weight: 25 },
    { level: 'warn', weight: 10 },
    { level: 'error', weight: 5 }
];

function getRandomSeverity() {
    const r = rand() * 100;
    let sum = 0;
    for (const s of severities) {
        sum += s.weight;
        if (r < sum) return s.level;
    }
    return 'debug';
}

const services = ['auth-service', 'user-service', 'payment-service', 'email-service', 'inventory-service', 'order-service', 'search-service', 'notification-service'];

function getRandomService() {
    return services[Math.floor(rand() * services.length)];
}

const templates = [
    "User {user} logged in successfully",
    "Failed to authenticate user {user}",
    "Payment of {amount} processed for order {order}",
    "Order {order} created by user {user}",
    "Item {item} out of stock",
    "Email sent to {email}",
    "Search query '{query}' returned {count} results",
    "Notification sent to user {user}",
    "Database connection established",
    "Cache miss for key {key}",
    "Disk space running low on {node}",
    "High CPU usage detected on {node}",
    "Service {service} restarted",
    "Invalid request payload from {ip}",
    "Rate limit exceeded for {ip}"
];

const users = ['alice', 'bob', 'charlie', 'dave', 'eve'];
const items = ['laptop', 'phone', 'tablet', 'monitor', 'keyboard'];
const nodes = ['node-1', 'node-2', 'node-3', 'node-4'];

function getRandomMessage() {
    const template = templates[Math.floor(rand() * templates.length)];
    return template
        .replace('{user}', users[Math.floor(rand() * users.length)])
        .replace('{amount}', '$' + (Math.floor(rand() * 1000) + 1))
        .replace('{order}', 'ORD-' + Math.floor(rand() * 10000))
        .replace('{item}', items[Math.floor(rand() * items.length)])
        .replace('{email}', users[Math.floor(rand() * users.length)] + '@example.com')
        .replace('{query}', items[Math.floor(rand() * items.length)])
        .replace('{count}', Math.floor(rand() * 100))
        .replace('{key}', 'key-' + Math.floor(rand() * 1000))
        .replace('{node}', nodes[Math.floor(rand() * nodes.length)])
        .replace('{service}', services[Math.floor(rand() * services.length)])
        .replace('{ip}', `192.168.1.${Math.floor(rand() * 255)}`);
}

async function initDb() {
    db = new PGlite(dbPath);
    await db.waitReady;

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

    if (count < 100000) {
        console.log('Seeding database...');
        await db.exec('TRUNCATE TABLE logs;');
        
        const totalRows = 100000;
        const batchSize = 5000;
        const now = new Date('2023-10-01T00:00:00Z').getTime();
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

        for (let i = 0; i < totalRows; i += batchSize) {
            let values = [];
            for (let j = 0; j < batchSize; j++) {
                const ts = new Date(now - rand() * thirtyDaysMs).toISOString();
                const severity = getRandomSeverity();
                const service = getRandomService();
                const message = getRandomMessage();
                // Escape single quotes in message
                const escapedMessage = message.replace(/'/g, "''");
                values.push(`('${ts}', '${severity}', '${service}', '${escapedMessage}')`);
            }
            await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')};`);
            console.log(`Seeded ${i + batchSize} rows`);
        }
        console.log('Seeding complete.');
    } else {
        console.log('Database already seeded.');
    }

    // Create indexes
    console.log('Creating indexes...');
    // Index for ordering by ts
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);
    // Index for severity + ordering
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);
    // Index for substring search (trigram index)
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    console.log('Indexes created.');
}

app.get('/api/stats', async (req, res) => {
    try {
        const totalRes = await db.query('SELECT COUNT(*) as count FROM logs;');
        const total = parseInt(totalRes.rows[0].count, 10);

        const severityRes = await db.query('SELECT severity, COUNT(*) as count FROM logs GROUP BY severity;');
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
        if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
            return res.status(400).json({ error: 'Invalid severity' });
        }

        let conditions = [];
        let params = [];
        let paramIndex = 1;

        if (severity) {
            conditions.push(`severity = $${paramIndex++}`);
            params.push(severity);
        }

        if (q) {
            conditions.push(`message ILIKE $${paramIndex++}`);
            params.push(\`%\${q}%\`);
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        const countQuery = \`SELECT COUNT(*) as count FROM logs \${whereClause};\`;
        const countRes = await db.query(countQuery, params);
        const total = parseInt(countRes.rows[0].count, 10);

        const dataQuery = \`
            SELECT id, ts, severity, service, message 
            FROM logs 
            \${whereClause} 
            ORDER BY ts DESC 
            LIMIT $${paramIndex++} OFFSET $${paramIndex++};
        \`;
        const dataParams = [...params, limit, offset];
        const dataRes = await db.query(dataQuery, dataParams);

        res.json({ total, rows: dataRes.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
    app.listen(PORT, () => {
        console.log(\`Backend listening on port \${PORT}\`);
    });
}).catch(err => {
    console.error('Failed to initialize database', err);
    process.exit(1);
});
