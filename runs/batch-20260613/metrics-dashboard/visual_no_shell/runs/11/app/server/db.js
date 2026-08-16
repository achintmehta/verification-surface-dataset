import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

// Deterministic pseudo-random generator (mulberry32) so seeds are reproducible.
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

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
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
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'light'
    );
  `);
}

async function seedIfEmpty(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (res.rows[0].c > 0) {
    // ensure settings row exists
    const s = await db.query('SELECT COUNT(*)::int AS c FROM settings');
    if (s.rows[0].c === 0) {
      await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light')");
    }
    return;
  }

  const rand = mulberry32(20240517);

  // 30 days of daily metrics ending "today" (fixed anchor for determinism of values,
  // but dates anchored to a fixed reference date so seed is fully deterministic).
  const anchor = new Date(Date.UTC(2024, 4, 30)); // 2024-05-30
  let baseVisitors = 1200;
  let baseRevenue = 8500;
  const dailyValues = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    // smooth-ish walk
    baseVisitors += Math.round((rand() - 0.45) * 220);
    if (baseVisitors < 300) baseVisitors = 300;
    baseRevenue += (rand() - 0.45) * 1600;
    if (baseRevenue < 2000) baseRevenue = 2000;
    const visitors = baseVisitors;
    const revenue = Math.round(baseRevenue * 100) / 100;
    const dateStr = d.toISOString().slice(0, 10);
    dailyValues.push({ dateStr, visitors, revenue });
  }
  for (const row of dailyValues) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [row.dateStr, row.visitors, row.revenue]
    );
  }

  const categories = [
    { name: 'Direct Traffic', value: 482300 },
    { name: 'Organic Search', value: 731050 },
    { name: 'Paid Campaigns', value: 295600 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284750 },
    { name: 'Social Referrals', value: 158900 },
    { name: 'Email Outreach', value: 96400 }
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  const itemNames = [
    'Quarterly Renewal', 'Onboarding Package', 'Premium Upgrade', 'API Overage',
    'Support Retainer', 'Data Migration', 'Custom Integration', 'Annual License',
    'Seat Expansion', 'Security Audit', 'Training Session', 'Sandbox Provision',
    'SLA Upgrade', 'Compliance Review', 'Storage Add-on', 'Analytics Module',
    'Webhook Bundle', 'Priority Routing', 'Backup Tier', 'Region Expansion'
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((500 + rand() * 49500) * 100) / 100;
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - Math.floor(rand() * 30));
    d.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, d.toISOString()]
    );
  }

  await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light')");
}
