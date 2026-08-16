import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let db;

/**
 * Deterministic pseudo-random number generator (mulberry32).
 * A fixed seed guarantees the same dataset on every fresh boot.
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

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

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
  const res = await db.query('SELECT COUNT(*)::int AS count FROM daily_metrics');
  if (res.rows[0].count > 0) return;

  const rng = mulberry32(20240517);

  // --- daily_metrics: 30 days ending "today" (deterministic dates relative
  // to a fixed anchor so seed is reproducible) ---
  // Anchor date fixed so the seed is fully deterministic across machines.
  const anchor = new Date(Date.UTC(2024, 5, 30)); // 2024-06-30
  const days = 30;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    // smooth-ish series with noise
    const base = 1200 + Math.round(Math.sin((days - i) / 4) * 300);
    const visitors = base + Math.round(rng() * 400);
    const revenue = +(visitors * (3 + rng() * 4)).toFixed(2);
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [isoDate(d), visitors, revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ---
  const categories = [
    { name: 'Marketing', value: 482300 },
    { name: 'Sales', value: 731020 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284500 },
    { name: 'Support', value: 219740 },
    { name: 'Product', value: 564110 },
    { name: 'Operations', value: 398220 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      c.name,
      c.value,
    ]);
  }

  // --- recent_items: 20 rows ---
  const itemNames = [
    'Acme Corp Renewal',
    'Northwind Trading',
    'Globex Onboarding',
    'Initech License',
    'Umbrella Health Audit',
    'Soylent Subscription',
    'Hooli Cloud Migration',
    'Pied Piper Upgrade',
    'Stark Industries Deal',
    'Wayne Enterprises Contract',
    'Wonka Logistics',
    'Cyberdyne Support Plan',
    'Tyrell Analytics',
    'Oscorp Research Grant',
    'Aperture Test Bundle',
    'Massive Dynamic Pilot',
    'Vandelay Imports',
    'Gekko Capital Advisory',
    'Bluth Company Setup',
    'Dunder Mifflin Reorder',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < itemNames.length; i++) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - Math.floor(rng() * 14));
    d.setUTCHours(Math.floor(rng() * 24), Math.floor(rng() * 60), 0, 0);
    const value = +(500 + rng() * 49500).toFixed(2);
    const category = catNames[Math.floor(rng() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, d.toISOString()]
    );
  }

  // --- settings: single row ---
  await db.query(
    'INSERT INTO settings (id, theme) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
    ['light']
  );
}
