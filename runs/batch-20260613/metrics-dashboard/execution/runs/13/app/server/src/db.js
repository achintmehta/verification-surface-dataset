import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

/**
 * A small, fully deterministic PRNG (mulberry32) so the seed is reproducible
 * across boots and across independent implementations.
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
      id        SERIAL PRIMARY KEY,
      day       DATE NOT NULL UNIQUE,
      visitors  INTEGER NOT NULL,
      revenue   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL,
      value  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL,
      value       NUMERIC(12,2) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id     INTEGER PRIMARY KEY DEFAULT 1,
      theme  TEXT NOT NULL DEFAULT 'light',
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
}

async function seedIfEmpty(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) return;

  const rand = mulberry32(20240517);

  // ---- daily_metrics: 30 days ending "today" (deterministic relative dates) ----
  // Use a fixed anchor date so the seed is fully deterministic regardless of when
  // the server first boots.
  const anchor = new Date(Date.UTC(2024, 4, 30)); // 2024-05-30
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    // smooth-ish series with noise
    const base = 1200 + Math.sin((29 - i) / 4) * 350;
    const visitors = Math.round(base + rand() * 600);
    const revenue = Math.round((visitors * (8 + rand() * 6)) * 100) / 100;
    days.push({ day: dayStr, visitors, revenue });
  }

  for (const d of days) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [d.day, d.visitors, d.revenue]
    );
  }

  // ---- categories: 6 rows, one long label, one value >= 1,000,000 ----
  const categories = [
    { name: 'Direct', value: 482310 },
    { name: 'Organic Search', value: 731255 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284907 },
    { name: 'Referral', value: 203418 },
    { name: 'Social', value: 356702 },
    { name: 'Email', value: 158340 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // ---- recent_items: 20 rows ----
  const itemNouns = [
    'Onboarding Flow', 'Pricing Page', 'Checkout Optimization', 'API Gateway',
    'Mobile Redesign', 'Data Pipeline', 'Billing Service', 'Search Indexer',
    'Notification Hub', 'Analytics Export', 'User Directory', 'Webhook Relay',
    'Report Builder', 'Audit Logging', 'Session Manager', 'Feature Flags',
    'Cache Layer', 'Image CDN', 'Email Templates', 'Access Controls',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNouns[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((500 + rand() * 9500) * 100) / 100;
    const created = new Date(anchor);
    created.setUTCDate(anchor.getUTCDate() - Math.floor(rand() * 30));
    created.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // ---- settings: single row ----
  await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING");
}
