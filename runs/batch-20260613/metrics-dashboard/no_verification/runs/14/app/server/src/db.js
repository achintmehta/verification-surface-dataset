import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

/**
 * A tiny deterministic PRNG (mulberry32) so the seed is reproducible across
 * boots and across any two correct implementations using the same seed.
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

const SEED = 1337;

let db;

export async function getDb() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await migrate(db);
  await seed(db);
  return db;
}

async function migrate(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day        DATE PRIMARY KEY,
      visitors   INTEGER NOT NULL,
      revenue    INTEGER NOT NULL
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
      value      INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

async function seed(database) {
  const { rows } = await database.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) return; // already seeded

  const rand = mulberry32(SEED);

  // --- daily_metrics: 30 days ending today ---------------------------------
  const days = 30;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    // gentle upward trend + deterministic noise
    const base = 800 + (days - i) * 18;
    const visitors = Math.round(base + (rand() - 0.5) * 320);
    const revenue = Math.round(visitors * (4 + rand() * 6));
    await database.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [isoDay(d), visitors, revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ----------
  const categories = [
    ['Direct', 482300],
    ['Organic Search', 731900],
    ['Enterprise Infrastructure & Compliance', 1284750],
    ['Referral', 219400],
    ['Social', 354120],
    ['Email', 168930],
  ];
  for (const [name, value] of categories) {
    await database.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
  }

  // --- recent_items: 20 rows ----------------------------------------------
  const itemNames = [
    'Quarterly revenue export', 'New signup batch', 'Refund processed',
    'Subscription upgrade', 'Invoice generated', 'API key rotated',
    'Data import completed', 'Plan downgrade', 'Webhook delivered',
    'Trial converted', 'Seat added', 'Usage report compiled',
    'Payment retried', 'Account merged', 'Discount applied',
    'Churn flagged', 'Onboarding finished', 'Annual renewal',
    'Compliance audit log', 'Bulk user provisioning',
  ];
  const catNames = categories.map((c) => c[0]);

  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round(50 + rand() * 9950);
    const created = new Date(now - i * 3600 * 1000 * (1 + Math.floor(rand() * 5)));
    await database.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // --- settings: default theme --------------------------------------------
  await database.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );
}
