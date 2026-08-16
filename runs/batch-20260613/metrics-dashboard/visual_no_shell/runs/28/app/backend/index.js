import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Initialize PGLite
const db = new PGlite('./pglite-data');

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue DECIMAL(10,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if seeded
  const { rows: metricCount } = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricCount[0].count) === 0) {
    await seedData();
  }
}

async function seedData() {
  console.log('Seeding deterministic data...');

  // 30 days of metrics starting from 2024-09-01
  const baseDate = new Date('2024-09-01');
  const dailyInserts = [];
  let visitors = 1200;
  let revenue = 45000;
  for (let i = 0; i < 30; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    // Deterministic variation
    visitors = Math.floor(1200 + Math.sin(i / 3) * 800 + (i % 5) * 50);
    revenue = Math.floor(45000 + Math.cos(i / 2) * 15000 + (i % 7) * 2000);
    dailyInserts.push(`('${dateStr}', ${visitors}, ${revenue})`);
  }
  await db.exec(`
    INSERT INTO daily_metrics (date, visitors, revenue) VALUES 
    ${dailyInserts.join(', ')}
  `);

  // 6 categories, one long name, one >=1M
  await db.exec(`
    INSERT INTO categories (name, value) VALUES 
    ('Direct', 485000),
    ('Organic Search', 720000),
    ('Paid Search', 310000),
    ('Social Media', 195000),
    ('Referral', 890000),
    ('Enterprise Infrastructure & Compliance', 1250000)
  `);

  // 20 recent items
  const items = [
    ['Acme Corp - Enterprise License', 'Enterprise', 125000, '2024-09-29 14:30:00'],
    ['StartupXYZ Onboarding', 'SMB', 45000, '2024-09-29 12:15:00'],
    ['TechFlow Pro Subscription', 'Mid-Market', 78000, '2024-09-28 16:45:00'],
    ['GlobalBank Analytics Package', 'Enterprise', 340000, '2024-09-28 09:20:00'],
    ['RetailMax Inventory Module', 'SMB', 22000, '2024-09-27 11:00:00'],
    ['HealthFirst Compliance Suite', 'Enterprise', 195000, '2024-09-27 08:30:00'],
    ['EduLearn Platform Access', 'Mid-Market', 56000, '2024-09-26 15:10:00'],
    ['FinServe Risk Dashboard', 'Enterprise', 275000, '2024-09-26 13:40:00'],
    ['CloudSync Backup Pro', 'SMB', 18500, '2024-09-25 10:25:00'],
    ['MediaStream Content Tools', 'Mid-Market', 92000, '2024-09-25 17:55:00'],
    ['LogiTrack Supply Chain', 'Enterprise', 410000, '2024-09-24 14:00:00'],
    ['ShopLocal POS Upgrade', 'SMB', 31000, '2024-09-24 11:35:00'],
    ['DataViz Pro License', 'Mid-Market', 67000, '2024-09-23 09:45:00'],
    ['SecureNet Firewall Bundle', 'Enterprise', 155000, '2024-09-23 16:20:00'],
    ['GrowFast Marketing Suite', 'SMB', 27000, '2024-09-22 12:50:00'],
    ['InsureRight Policy Manager', 'Mid-Market', 83000, '2024-09-22 08:15:00'],
    ['BuildRight Construction ERP', 'Enterprise', 520000, '2024-09-21 15:30:00'],
    ['PetCare Vet Portal', 'SMB', 14000, '2024-09-21 10:40:00'],
    ['AutoDrive Fleet Analytics', 'Mid-Market', 115000, '2024-09-20 14:25:00'],
    ['QuantumCore Research DB', 'Enterprise', 890000, '2024-09-20 11:05:00']
  ];

  const itemInserts = items.map(item => 
    `('${item[0]}', '${item[1]}', ${item[2]}, '${item[3]}')`
  );
  await db.exec(`
    INSERT INTO recent_items (name, category, value, created_at) VALUES 
    ${itemInserts.join(', ')}
  `);

  // Default settings
  await db.exec(`
    INSERT INTO settings (key, value) VALUES ('theme', 'light')
    ON CONFLICT (key) DO NOTHING
  `);

  console.log('Seeding complete.');
}

await initDb();

// API Routes

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const { rows: totalVisitorsRows } = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalVisitors = parseInt(totalVisitorsRows[0].total);

    const { rows: totalRevenueRows } = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const totalRevenue = parseFloat(totalRevenueRows[0].total).toFixed(2);

    const { rows: bestDayRows } = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const bestDay = bestDayRows[0].date.toISOString().split('T')[0];
    const bestDayVisitors = bestDayRows[0].visitors;

    // 7-day trend
    const { rows: recent } = await db.query(`
      SELECT visitors FROM daily_metrics 
      ORDER BY date DESC LIMIT 14
    `);
    const last7 = recent.slice(0, 7).reduce((a, b) => a + b.visitors, 0);
    const prev7 = recent.slice(7, 14).reduce((a, b) => a + b.visitors, 0);
    const trend = prev7 > 0 ? ((last7 - prev7) / prev7 * 100).toFixed(1) : '0.0';

    res.json({
      totalVisitors,
      totalRevenue: parseFloat(totalRevenue),
      bestDay,
      bestDayVisitors,
      sevenDayTrend: parseFloat(trend)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT date, visitors, revenue 
      FROM daily_metrics 
      ORDER BY date ASC
    `);
    const data = rows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      visitors: r.visitors,
      revenue: parseFloat(r.revenue)
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent
app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT name, category, value, created_at 
      FROM recent_items 
      ORDER BY created_at DESC
    `);
    const data = rows.map(r => ({
      name: r.name,
      category: r.category,
      value: parseFloat(r.value),
      created_at: r.created_at.toISOString()
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = rows.length > 0 ? rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.exec(`
      INSERT INTO settings (key, value) VALUES ('theme', '${theme}')
      ON CONFLICT (key) DO UPDATE SET value = '${theme}'
    `);
    res.json({ theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});