import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'pgdata');

// Deterministic pseudo-random generator (mulberry32) seeded with a fixed value.
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

function pad(n) {
  return String(n).padStart(2, '0');
}

// Build a deterministic list of the last 30 calendar days ending on a fixed anchor date,
// so the seed (and therefore the rendered dashboard) is fully reproducible.
function buildDates(count) {
  const anchor = new Date(Date.UTC(2024, 0, 30)); // 2024-01-30
  const dates = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    dates.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return dates;
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  await seedIfEmpty(db);
  dbInstance = db;
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue INTEGER NOT NULL
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
      value INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL
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

  const rand = mulberry32(1337);
  const dates = buildDates(30);

  // daily_metrics: 30 rows
  for (let i = 0; i < dates.length; i++) {
    const trend = 1 + i * 0.015; // gentle upward trend
    const noise = 0.7 + rand() * 0.6;
    const visitors = Math.round(800 * trend * noise) + 200;
    const revenue = Math.round(visitors * (3 + rand() * 4));
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [dates[i], visitors, revenue]
    );
  }

  // categories: 6 rows, includes one long label and one value >= 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284500 },
    { name: 'Marketing', value: 642300 },
    { name: 'Sales', value: 531900 },
    { name: 'Support', value: 318450 },
    { name: 'Research', value: 219800 },
    { name: 'Operations', value: 156200 }
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // recent_items: 20 rows
  const itemNames = [
    'Quarterly Report', 'Onboarding Flow', 'API Gateway', 'Billing Sync',
    'Data Export', 'User Survey', 'Cache Layer', 'Email Campaign',
    'Mobile Release', 'Audit Log', 'Search Index', 'Webhook Retry',
    'Dashboard Tile', 'Rate Limiter', 'Backup Job', 'Feature Flag',
    'Schema Migration', 'Image Pipeline', 'Notification Queue', 'Session Store'
  ];
  const catNames = categories.map((c) => c.name);
  const anchor = new Date(Date.UTC(2024, 0, 30, 12, 0, 0));
  for (let i = 0; i < 20; i++) {
    const created = new Date(anchor);
    created.setUTCHours(anchor.getUTCHours() - i * 7);
    const value = Math.round(500 + rand() * 9500);
    const category = catNames[Math.floor(rand() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, created.toISOString()]
    );
  }

  // default theme
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light')");
}
