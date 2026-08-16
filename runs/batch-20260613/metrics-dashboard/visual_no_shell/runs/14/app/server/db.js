import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'pgdata');

/**
 * A tiny deterministic pseudo-random number generator (mulberry32).
 * Given the same seed, it always produces the same sequence, so the
 * seeded dataset is identical across boots and across machines.
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
      day DATE PRIMARY KEY,
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
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (rows[0].c > 0) return;

  const rand = mulberry32(1337);

  // ---- daily_metrics: 30 days ending today (deterministic, but ending on
  // a FIXED anchor date so values never change between runs) ----
  const anchor = new Date(Date.UTC(2024, 0, 30)); // 2024-01-30
  const dayRows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    // base trend with daily noise
    const base = 800 + (29 - i) * 18;
    const visitors = Math.round(base + (rand() - 0.5) * 320);
    const revenue = +(visitors * (3 + rand() * 4)).toFixed(2);
    dayRows.push([dayStr, Math.max(0, visitors), revenue]);
  }
  for (const [day, visitors, revenue] of dayRows) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1,$2,$3)',
      [day, visitors, revenue]
    );
  }

  // ---- categories: 6 rows, one long label, one value >= 1,000,000 ----
  const categories = [
    ['Marketing', 482300],
    ['Sales', 731950],
    ['Enterprise Infrastructure & Compliance', 1284560],
    ['Support', 198420],
    ['Research', 356700],
    ['Operations', 642100],
  ];
  for (const [name, value] of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1,$2)', [name, value]);
  }

  // ---- recent_items: 20 rows ----
  const itemNames = [
    'Quarterly Report', 'New Lead', 'Invoice #4821', 'Support Ticket',
    'Contract Renewal', 'Demo Request', 'Webinar Signup', 'Feature Request',
    'Bug Report', 'Onboarding Call', 'Payment Received', 'Refund Issued',
    'Trial Started', 'Account Upgrade', 'Data Export', 'API Key Created',
    'Team Invite', 'Subscription Cancelled', 'Feedback Submitted', 'Integration Added',
  ];
  const catNames = categories.map((c) => c[0]);
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = +(50 + rand() * 9950).toFixed(2);
    const created = new Date(anchor);
    created.setUTCDate(anchor.getUTCDate() - Math.floor(rand() * 14));
    created.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1,$2,$3,$4)',
      [name, category, value, created.toISOString()]
    );
  }

  // ---- settings ----
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );
}
