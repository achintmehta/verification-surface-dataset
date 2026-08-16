const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'pglite-data');
const db = new PGlite(dbPath);

const TOTAL_ROWS = 100000;
const SERVICES = ['auth', 'api', 'worker', 'db', 'cache', 'frontend', 'billing', 'search'];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];

function mulberry32(a) {
    return function() {
      var t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

const rand = mulberry32(12345);

function getRandomSeverity() {
    const r = rand() * 100;
    if (r < 60) return 'debug';
    if (r < 85) return 'info';
    if (r < 95) return 'warn';
    return 'error';
}

function getRandomService() {
    return SERVICES[Math.floor(rand() * SERVICES.length)];
}

const MESSAGES = [
    "User login failed for user {user}",
    "Connection timeout to {ip}",
    "Processed {count} records successfully",
    "Disk space running low on {disk}",
    "Cache miss for key {key}",
    "Starting background job {job}",
    "Invalid payload received from {ip}",
    "Service {service} restarted"
];

function getRandomMessage() {
    const template = MESSAGES[Math.floor(rand() * MESSAGES.length)];
    return template
        .replace('{user}', `user_${Math.floor(rand() * 1000)}`)
        .replace('{ip}', `${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`)
        .replace('{count}', Math.floor(rand() * 10000))
        .replace('{disk}', `/dev/sd${String.fromCharCode(97 + Math.floor(rand() * 4))}`)
        .replace('{key}', `key_${Math.floor(rand() * 100000)}`)
        .replace('{job}', `job_${Math.floor(rand() * 100)}`)
        .replace('{service}', SERVICES[Math.floor(rand() * SERVICES.length)]);
}

async function initDb() {
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

    const res = await db.query(`SELECT COUNT(*) as count FROM logs`);
    const count = parseInt(res.rows[0].count, 10);

    if (count < TOTAL_ROWS) {
        console.log('Seeding database...');
        await db.exec('BEGIN');
        
        const batchSize = 5000;
        const now = new Date('2023-01-01T00:00:00Z').getTime();
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

        for (let i = 0; i < TOTAL_ROWS; i += batchSize) {
            const values = [];
            for (let j = 0; j < batchSize && i + j < TOTAL_ROWS; j++) {
                const ts = new Date(now + (rand() * thirtyDaysMs)).toISOString();
                const severity = getRandomSeverity();
                const service = getRandomService();
                const message = getRandomMessage();
                values.push(`('${ts}', '${severity}', '${service}', '${message.replace(/'/g, "''")}')`);
            }
            await db.exec(`INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`);
            console.log(`Inserted ${i + values.length} rows`);
        }
        
        console.log('Creating indexes...');
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_logs_ts_message_id ON logs(ts DESC, message, id);
            CREATE INDEX IF NOT EXISTS idx_logs_sev_ts_msg_id ON logs(severity, ts DESC, message, id);
        `);
        
        await db.exec('COMMIT');
        
        console.log('Vacuuming...');
        await db.exec('VACUUM ANALYZE logs;');
        
        console.log('Seeding complete.');
    } else {
        console.log('Database already seeded.');
    }

    // Disable seqscan to force index usage for ILIKE queries with ORDER BY ts DESC
    // await db.exec(`SET enable_seqscan = off;`);
}

const countCache = new Map();

async function getCount(severity, q) {
    const key = `${severity || ''}|${q || ''}`;
    if (countCache.has(key)) return countCache.get(key);
    
    let query = `SELECT COUNT(*) as count FROM logs`;
    let conditions = [];
    let params = [];
    if (severity) {
        conditions.push(`severity = $${params.length + 1}`);
        params.push(severity);
    }
    if (q) {
        conditions.push(`message ILIKE $${params.length + 1}`);
        params.push(`%${q}%`);
    }
    if (conditions.length > 0) {
        query += ` WHERE ` + conditions.join(' AND ');
    }
    const res = await db.query(query, params);
    const count = parseInt(res.rows[0].count, 10);
    countCache.set(key, count);
    return count;
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

        const total = await getCount(severity, q);

        let innerQuery = `SELECT id FROM logs`;
        let conditions = [];
        let params = [];

        if (severity) {
            conditions.push(`severity = $${params.length + 1}`);
            params.push(severity);
        }
        if (q) {
            conditions.push(`message ILIKE $${params.length + 1}`);
            params.push(`%${q}%`);
        }

        if (conditions.length > 0) {
            innerQuery += ` WHERE ` + conditions.join(' AND ');
        }

        innerQuery += ` ORDER BY ts DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const query = `SELECT * FROM logs WHERE id IN (${innerQuery}) ORDER BY ts DESC`;

        if (req.query.explain) {
            const explainRes = await db.query('EXPLAIN ANALYZE ' + query, params);
            return res.json({ explain: explainRes.rows });
        }

        const result = await db.query(query, params);

        res.json({
            total,
            rows: result.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const totalRes = await db.query('SELECT COUNT(*) as count FROM logs');
        const total = parseInt(totalRes.rows[0].count, 10);

        const severityRes = await db.query('SELECT severity, COUNT(*) as count FROM logs GROUP BY severity');
        const counts = {};
        for (const row of severityRes.rows) {
            counts[row.severity] = parseInt(row.count, 10);
        }

        res.json({ total, counts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const PORT = process.env.PORT || 3001;
initDb().then(() => {
    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
});