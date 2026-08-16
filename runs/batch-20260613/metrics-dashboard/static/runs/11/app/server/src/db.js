import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Persist PGLite to the local file system (a directory under server/).
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

let dbInstance = null;

/**
 * A small, deterministic pseudo-random number generator (mulberry32).
 * Given the same seed it always produces the same sequence, so seeding
 * the database is fully reproducible across boots and machines.
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

/** Format a Date as YYYY-MM-DD using UTC components. */
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day       DATE PRIMARY KEY,
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

async function seedIfEmpty(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) {
    return; // Already seeded.
  }

  const rand = mulberry32(1337); // Fixed seed -> deterministic data.

  // --- 30 days of daily metrics, ending "today" (anchored to a fixed date
  // so the seed is fully deterministic regardless of when it runs). ---
  const anchor = new Date(Date.UTC(2024, 0, 30)); // 2024-01-30
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const dayIndex = 29 - i;
    // A gently rising base with deterministic noise.
    const base = 1200 + dayIndex * 35;
    const visitors = Math.round(base + (rand() - 0.5) * 600);
    const revenue = Math.round((visitors * (8 + rand() * 6)) * 100) / 100;
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [isoDate(d), visitors, revenue]
    );
  }

  // --- 6 categories; includes a deliberately long label and a 7-digit value. ---
  const categories = [
    ['Enterprise Infrastructure & Compliance', 1284500],
    ['Marketing', 642300],
    ['Product', 531900],
    ['Support', 318750],
    ['Sales', 904120],
    ['Research', 207680],
  ];
  for (const [name, value] of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
  }

  // --- 20 recent items. ---
  const itemNames = [
    'Quarterly Report', 'Onboarding Flow', 'Billing Sync', 'API Gateway',
    'Data Export', 'Audit Log', 'Webhook Retry', 'Cache Layer',
    'Search Index', 'User Invite', 'Rate Limiter', 'Backup Job',
    'Email Digest', 'Schema Migration', 'Feature Flag', 'Session Store',
    'Image Pipeline', 'Notification Queue', 'CSV Importer', 'Health Check',
  ];
  const itemCategories = categories.map((c) => c[0]);
  for (let i = 0; i < itemNames.length; i++) {
    const category = itemCategories[Math.floor(rand() * itemCategories.length)];
    const value = Math.round((50 + rand() * 9950) * 100) / 100;
    const created = new Date(anchor);
    created.setUTCHours(anchor.getUTCHours() - i * 7);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, created.toISOString()]
    );
  }

  // --- Default theme setting. ---
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );
}

export async function getDb() {
  if (dbInstance) return dbInstance;
  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await createSchema(db);
  await seedIfEmpty(db);
  dbInstance = db;
  return db;
}
