import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

/**
 * A tiny, deterministic pseudo-random number generator (mulberry32).
 * Given a fixed seed it always produces the same sequence, so every boot
 * (and every correct implementation using the same seed) renders comparable
 * data.
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
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'light',
      CONSTRAINT settings_singleton CHECK (id = 1)
    );
  `);
}

async function seedIfEmpty(db) {
  const res = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (res.rows[0].count > 0) {
    // Ensure settings row exists even if other tables were seeded.
    await ensureSettings(db);
    return;
  }

  const rand = mulberry32(20240517);

  // ---- daily_metrics: 30 days ending "today" (deterministic dates) ----
  // Use a fixed anchor date so the seed is fully deterministic regardless of
  // when the server first boots.
  const anchor = new Date(Date.UTC(2024, 4, 30)); // 2024-05-30
  const dailyRows = [];
  let baseVisitors = 1800;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    // Smooth-ish wandering series with a mild upward trend.
    const trend = (29 - i) * 12;
    const noise = Math.floor((rand() - 0.5) * 600);
    const visitors = Math.max(200, baseVisitors + trend + noise);
    const revenue = +(visitors * (2.5 + rand() * 2)).toFixed(2);
    dailyRows.push({ date: dateStr, visitors, revenue });
  }

  for (const row of dailyRows) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [row.date, row.visitors, row.revenue]
    );
  }

  // ---- categories: 6 rows, one long label, one value >= 1,000,000 ----
  const categories = [
    { name: 'Marketing', value: 482300 },
    { name: 'Sales', value: 731450 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284900 },
    { name: 'Support', value: 219800 },
    { name: 'Research', value: 356200 },
    { name: 'Operations', value: 540100 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      c.name,
      c.value,
    ]);
  }

  // ---- recent_items: 20 rows ----
  const itemNouns = [
    'Quarterly Report',
    'Onboarding Flow',
    'API Migration',
    'Billing Update',
    'Dashboard Redesign',
    'Security Audit',
    'Feature Rollout',
    'Data Export',
    'Customer Survey',
    'Performance Review',
    'Cache Warmup',
    'Index Rebuild',
    'Email Campaign',
    'Webhook Retry',
    'Schema Change',
    'Backup Restore',
    'Load Test',
    'Pricing Experiment',
    'Region Failover',
    'Compliance Check',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNouns[i % itemNouns.length];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = +(50 + rand() * 9950).toFixed(2);
    const created = new Date(anchor);
    created.setUTCDate(anchor.getUTCDate() - Math.floor(rand() * 30));
    created.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  await ensureSettings(db);
}

async function ensureSettings(db) {
  const res = await db.query('SELECT COUNT(*)::int AS count FROM settings');
  if (res.rows[0].count === 0) {
    await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light')");
  }
}
