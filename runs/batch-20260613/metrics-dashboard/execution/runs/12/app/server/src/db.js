import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

/**
 * A small, deterministic PRNG (mulberry32) so the seed is reproducible
 * across boots and across implementations.
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

// A fixed "today" so that dates are deterministic regardless of when the
// server first boots. The dashboard talks about a "30-day" series; the
// absolute calendar dates only need to be internally consistent.
const ANCHOR_DATE = new Date(Date.UTC(2024, 0, 30)); // 2024-01-30

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

const CATEGORY_NAMES = [
  'Marketing',
  'Sales',
  'Support',
  'Enterprise Infrastructure & Compliance',
  'Research',
  'Operations',
];

const ITEM_PREFIXES = [
  'Quarterly Report',
  'Onboarding Flow',
  'Invoice',
  'Support Ticket',
  'Feature Spec',
  'Audit Log',
  'Campaign',
  'Deployment',
];

let dbPromise = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = init();
  }
  return dbPromise;
}

async function init() {
  const db = new PGlite(DATA_DIR);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date     DATE PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL,
      value BIGINT NOT NULL
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

  await seed(db);
  return db;
}

async function seed(db) {
  const existing = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (existing.rows[0].n > 0) {
    // Already seeded — ensure a default theme row exists and return.
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', 'light')
       ON CONFLICT (key) DO NOTHING`
    );
    return;
  }

  const rand = mulberry32(SEED);

  // --- daily_metrics: 30 rows ending at ANCHOR_DATE ---
  const days = 30;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(ANCHOR_DATE.getTime() - i * 24 * 60 * 60 * 1000);
    // A gentle upward trend plus deterministic noise.
    const base = 400 + (days - 1 - i) * 12;
    const visitors = Math.round(base + (rand() - 0.5) * 180);
    const revenue = Math.round(visitors * (8 + rand() * 6));
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [ymd(d), Math.max(0, visitors), Math.max(0, revenue)]
    );
  }

  // --- categories: 6 rows; one long label; one value >= 1,000,000 ---
  for (let i = 0; i < CATEGORY_NAMES.length; i++) {
    const name = CATEGORY_NAMES[i];
    let value;
    if (name === 'Enterprise Infrastructure & Compliance') {
      value = 1_482_730; // deliberately 7-digit (>= 1,000,000)
    } else {
      value = Math.round(20000 + rand() * 180000);
    }
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      name,
      value,
    ]);
  }

  // --- recent_items: 20 rows ---
  for (let i = 0; i < 20; i++) {
    const prefix = ITEM_PREFIXES[Math.floor(rand() * ITEM_PREFIXES.length)];
    const name = `${prefix} #${1000 + i}`;
    const category = CATEGORY_NAMES[Math.floor(rand() * CATEGORY_NAMES.length)];
    const value = Math.round(50 + rand() * 9500);
    // Spread items over the trailing hours from the anchor date.
    const created = new Date(
      ANCHOR_DATE.getTime() - i * 7 * 60 * 60 * 1000 - Math.floor(rand() * 3600000)
    );
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // --- settings: default theme ---
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );
}
