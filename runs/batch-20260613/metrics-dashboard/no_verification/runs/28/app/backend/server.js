import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let db;

async function initDb() {
  db = new PGlite(join(__dirname, 'pglite-data'));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue DECIMAL(12,2) NOT NULL
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
      value DECIMAL(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if seeded
  const metricsCount = await db.query('SELECT COUNT(*) as count FROM daily_metrics');
  if (parseInt(metricsCount.rows[0].count) === 0) {
    await seedData();
  }
}

function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

async function seedData() {
  const rand = seededRandom(42);
  const today = new Date();
  const dailyInserts = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const visitors = Math.floor(150 + rand() * 400);
    const revenue = (2000 + rand() * 12000).toFixed(2);
    dailyInserts.push(`('${dateStr}', ${visitors}, ${revenue})`);
  }
  await db.exec(`
    INSERT INTO daily_metrics (date, visitors, revenue) VALUES 
    ${dailyInserts.join(', ')}
  `);

  const catData = [
    { name: 'Marketing', value: 485000 },
    { name: 'Sales', value: 920000 },
    { name: 'Product Development', value: 675000 },
    { name: 'Customer Support', value: 310000 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1450000 },
    { name: 'Operations', value: 540000 }
  ];
  const catInserts = catData.map(c => `('${c.name.replace(/'/g, "''")}', ${c.value})`).join(', ');
  await db.exec(`INSERT INTO categories (name, value) VALUES ${catInserts}`);

  const recentInserts = [];
  const itemNames = ['Acme Corp', 'Beta LLC', 'Gamma Inc', 'Delta Co', 'Epsilon Ltd', 'Zeta SA', 'Eta GmbH', 'Theta AG', 'Iota BV', 'Kappa SRL'];
  const itemCats = ['Marketing', 'Sales', 'Product Development', 'Customer Support', 'Enterprise Infrastructure & Compliance', 'Operations'];
  for (let i = 0; i < 20; i++) {
    const name = `${itemNames[i % itemNames.length]} #${Math.floor(i/10)+1}`;
    const cat = itemCats[Math.floor(rand() * itemCats.length)];
    const value = (500 + rand() * 9500).toFixed(2);
    const created = new Date(today.getTime() - (i * 86400000 * 0.7)).toISOString();
    recentInserts.push(`('${name.replace(/'/g,"''")}', '${cat}', ${value}, '${created}')`);
  }
  await db.exec(`
    INSERT INTO recent_items (name, category, value, created_at) VALUES 
    ${recentInserts.join(', ')}
  `);

  await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT DO NOTHING`);
}

app.get('/api/summary', async (req, res) => {
  try {
    const totalVisitors = await db.query('SELECT SUM(visitors) as total FROM daily_metrics');
    const totalRevenue = await db.query('SELECT SUM(revenue) as total FROM daily_metrics');
    const bestDay = await db.query('SELECT date, visitors FROM daily_metrics ORDER BY visitors DESC LIMIT 1');
    const last7 = await db.query(`
      SELECT SUM(visitors) as sum_vis FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 7
      ) t
    `);
    const prev7 = await db.query(`
      SELECT SUM(visitors) as sum_vis FROM (
        SELECT visitors FROM daily_metrics ORDER BY date DESC LIMIT 14 OFFSET 7
      ) t
    `);
    const v7 = parseInt(last7.rows[0].sum_vis) || 0;
    const p7 = parseInt(prev7.rows[0].sum_vis) || 1;
    const trend = Math.round(((v7 - p7) / p7) * 100);

    res.json({
      totalVisitors: parseInt(totalVisitors.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total).toFixed(2),
      bestDay: bestDay.rows[0].date,
      bestDayVisitors: parseInt(bestDay.rows[0].visitors),
      sevenDayTrend: trend
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeseries', async (req, res) => {
  try {
    const result = await db.query('SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT name, value FROM categories ORDER BY value DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const result = await db.query('SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    await db.exec(`INSERT INTO settings (key, value) VALUES ('theme', '${theme}') ON CONFLICT (key) DO UPDATE SET value = '${theme}'`);
    res.json({ theme });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);