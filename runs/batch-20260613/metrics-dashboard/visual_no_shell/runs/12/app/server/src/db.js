import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

// Deterministic pseudo-random generator (mulberry32) so the seed is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  await seedIfEmpty(db);
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
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
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function seedIfEmpty(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (res.rows[0].c > 0) return;

  const rnd = mulberry32(20240517);

  // 30 days of time-series, ending today.
  const days = 30;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const dailyRows = [];
  let baseVisitors = 1200;
  let baseRevenue = 8000;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    // gentle wave + noise, deterministic
    const wave = Math.sin((days - i) / 4) * 350;
    const visitors = Math.round(baseVisitors + wave + (rnd() - 0.5) * 400);
    const revenue = Math.round((baseRevenue + wave * 6 + (rnd() - 0.5) * 3000) * 100) / 100;
    dailyRows.push({ dateStr, visitors: Math.max(50, visitors), revenue: Math.max(500, revenue) });
    baseVisitors += 12;
    baseRevenue += 90;
  }
  for (const r of dailyRows) {
    await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [
      r.dateStr,
      r.visitors,
      r.revenue,
    ]);
  }

  // 6 categories incl. one long label and one value >= 1,000,000
  const categories = [
    { name: 'Marketing', value: 482300 },
    { name: 'Sales', value: 1284500 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1730900 },
    { name: 'Support', value: 318750 },
    { name: 'Research', value: 264100 },
    { name: 'Operations', value: 597600 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // 20 recent items
  const catNames = categories.map((c) => c.name);
  const itemNouns = [
    'Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Soylent', 'Stark Industries',
    'Wayne Enterprises', 'Wonka Co', 'Cyberdyne', 'Tyrell', 'Hooli', 'Pied Piper',
    'Massive Dynamic', 'Vandelay', 'Gekko & Co', 'Oscorp', 'Aperture', 'Black Mesa',
    'Nakatomi', 'Weyland-Yutani',
  ];
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const name = itemNouns[i];
    const category = catNames[Math.floor(rnd() * catNames.length)];
    const value = Math.round((rnd() * 95000 + 500) * 100) / 100;
    const created = new Date(now - i * 3.6e6 - Math.floor(rnd() * 3.6e6));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
    'theme',
    'light',
  ]);
}
