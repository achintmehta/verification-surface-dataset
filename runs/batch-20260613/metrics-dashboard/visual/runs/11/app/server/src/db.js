import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

// A small deterministic pseudo-random generator (mulberry32) seeded with a fixed value.
function makeRng(seed) {
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
  // ensure parent dir exists
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
      day DATE NOT NULL UNIQUE,
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
      id INTEGER PRIMARY KEY,
      theme TEXT NOT NULL DEFAULT 'light'
    );
  `);
}

async function seedIfEmpty(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics;');
  if (res.rows[0].c > 0) return;

  const rng = makeRng(20240517);

  // 30 days of metrics ending today (deterministic anchor date for reproducibility)
  const anchor = new Date('2024-05-30T00:00:00Z');
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    // visitors: smooth-ish wave + noise
    const base = 1200 + Math.sin((29 - i) / 4) * 400;
    const visitors = Math.round(base + rng() * 600);
    const revenue = +(visitors * (3 + rng() * 4)).toFixed(2);
    days.push({
      day: d.toISOString().slice(0, 10),
      visitors,
      revenue,
    });
  }
  for (const r of days) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1,$2,$3);',
      [r.day, r.visitors, r.revenue]
    );
  }

  // 6 categories, one long label, one value >= 1,000,000
  const categories = [
    { name: 'Direct', value: 482311 },
    { name: 'Organic Search', value: 731205 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284903 },
    { name: 'Social', value: 298140 },
    { name: 'Referral', value: 154872 },
    { name: 'Email', value: 96540 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1,$2);', [
      c.name,
      c.value,
    ]);
  }

  // 20 recent items
  const catNames = categories.map((c) => c.name);
  const itemWords = [
    'Quarterly Report', 'Onboarding Flow', 'Checkout Update', 'API Migration',
    'Pricing Page', 'Mobile Release', 'Data Export', 'Audit Log',
    'Billing Sync', 'Search Index', 'Email Digest', 'Webhook Retry',
    'Cache Warmup', 'Schema Change', 'Feature Flag', 'Rate Limiter',
    'Dashboard Tweak', 'CDN Purge', 'Backup Restore', 'Token Refresh',
  ];
  for (let i = 0; i < 20; i++) {
    const created = new Date(anchor);
    created.setUTCHours(anchor.getUTCHours() - i * 7 - Math.floor(rng() * 5));
    const value = +(50 + rng() * 9500).toFixed(2);
    const category = catNames[Math.floor(rng() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1,$2,$3,$4);',
      [itemWords[i], category, value, created.toISOString()]
    );
  }

  // default settings row
  await db.query(
    "INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;"
  );
}
