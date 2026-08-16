import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

/**
 * A tiny deterministic PRNG (mulberry32) so the seed is reproducible across
 * boots and across implementations. Returns floats in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 1337;

/** Format a Date as YYYY-MM-DD (UTC). */
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

let dbPromise = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = new PGlite(DATA_DIR);
      await migrate(db);
      await seed(db);
      return db;
    })();
  }
  return dbPromise;
}

async function migrate(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date      DATE PRIMARY KEY,
      visitors  INTEGER NOT NULL,
      revenue   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL,
      value  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function seed(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) {
    // Already seeded; make sure the theme setting exists.
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', 'light')
       ON CONFLICT (key) DO NOTHING`
    );
    return;
  }

  const rand = mulberry32(SEED);

  // --- daily_metrics: 30 days ending today (UTC) ---
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const dayIndex = 29 - i;
    // Gentle upward trend plus noise.
    const base = 800 + dayIndex * 18;
    const visitors = Math.round(base + (rand() - 0.5) * 360);
    const revenue = Math.round((visitors * (3 + rand() * 4)) * 100) / 100;
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [isoDate(d), visitors, revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ---
  const categories = [
    ['Direct', 482310],
    ['Organic Search', 731902],
    ['Paid Social', 295774],
    ['Enterprise Infrastructure & Compliance', 1284560],
    ['Referral', 158430],
    ['Email', 96420],
  ];
  for (const [name, value] of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
  }

  // --- recent_items: 20 rows ---
  const itemNames = [
    'Quarterly Report Export',
    'New User Onboarding',
    'Invoice #A-2291',
    'Subscription Renewal',
    'Bulk Data Import',
    'Dashboard View',
    'API Key Rotation',
    'Support Ticket Closed',
    'Feature Flag Updated',
    'Webhook Delivered',
    'Payment Captured',
    'Report Scheduled',
    'Account Upgraded',
    'Backup Completed',
    'Audit Log Reviewed',
    'Team Member Invited',
    'Integration Connected',
    'Usage Limit Adjusted',
    'Refund Processed',
    'Session Expired',
  ];
  const catNames = categories.map((c) => c[0]);
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((rand() * 9000 + 100) * 100) / 100;
    const createdAt = new Date(now - i * 3600 * 1000 * (1 + Math.floor(rand() * 6)));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // --- settings ---
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );
}
