import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

/**
 * A tiny deterministic PRNG (mulberry32) so the seed is reproducible.
 */
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
  dbInstance = new PGlite(DATA_DIR);
  await dbInstance.waitReady;
  await initSchema(dbInstance);
  await seedIfEmpty(dbInstance);
  return dbInstance;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
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
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      theme TEXT NOT NULL DEFAULT 'light'
    );
  `);
}

async function seedIfEmpty(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (res.rows[0].c > 0) {
    // Make sure settings row exists even if metrics were seeded earlier.
    await db.exec(`INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`);
    return;
  }

  const rand = mulberry32(123456789);

  // ---- daily_metrics: 30 days ending "today" (deterministic by index, not wall clock) ----
  // Use a fixed anchor date so the dataset is reproducible across boots.
  const anchor = new Date(Date.UTC(2024, 0, 30)); // Jan 30, 2024 (the 30th, latest day)
  const dailyRows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    // Build a smooth-ish series with noise.
    const base = 800 + Math.round(Math.sin((29 - i) / 4) * 250);
    const visitors = Math.max(50, base + Math.round((rand() - 0.5) * 300));
    const revenue = Math.round(visitors * (8 + rand() * 6)); // revenue per visitor
    dailyRows.push({ dateStr, visitors, revenue });
  }
  for (const r of dailyRows) {
    await db.query('INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)', [
      r.dateStr,
      r.visitors,
      r.revenue,
    ]);
  }

  // ---- categories: 6 rows, one long label, one value >= 1,000,000 ----
  const categories = [
    { name: 'Marketing', value: 482300 },
    { name: 'Sales', value: 731050 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284900 },
    { name: 'Support', value: 215600 },
    { name: 'Research', value: 398200 },
    { name: 'Operations', value: 564700 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // ---- recent_items: 20 rows ----
  const itemNames = [
    'Quarterly Report', 'Onboarding Flow', 'Pricing Update', 'Server Migration',
    'Customer Survey', 'Feature Launch', 'Bug Triage', 'Data Export',
    'API Refactor', 'Email Campaign', 'Dashboard Redesign', 'Security Audit',
    'Mobile Release', 'Webinar', 'Partner Sync', 'Contract Renewal',
    'Performance Review', 'Cache Tuning', 'Backup Restore', 'Roadmap Planning',
  ];
  const catNames = categories.map((c) => c.name);
  const recentAnchor = new Date(Date.UTC(2024, 0, 30, 12, 0, 0));
  for (let i = 0; i < 20; i++) {
    const created = new Date(recentAnchor);
    created.setUTCHours(recentAnchor.getUTCHours() - i * 7);
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = 100 + Math.round(rand() * 9900);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // ---- settings ----
  await db.exec(`INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`);
}
