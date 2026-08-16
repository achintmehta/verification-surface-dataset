import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.pgdata');

/**
 * Deterministic pseudo-random generator (mulberry32) so seeding is reproducible.
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
      id INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'light',
      CONSTRAINT settings_singleton CHECK (id = 1)
    );
  `);
}

async function seedIfEmpty(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (rows[0].c > 0) return;

  const rand = mulberry32(20240517);

  // 30 days of time-series data ending today.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const metrics = [];
  let baseVisitors = 1200;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    // Smooth-ish walk with weekly seasonality.
    const dayOfWeek = d.getUTCDay();
    const weekend = dayOfWeek === 0 || dayOfWeek === 6 ? 0.7 : 1;
    const drift = (rand() - 0.45) * 180;
    baseVisitors = Math.max(300, baseVisitors + drift);
    const visitors = Math.round(baseVisitors * weekend + rand() * 120);
    const revenue = +(visitors * (3.2 + rand() * 2.4)).toFixed(2);
    metrics.push({
      day: d.toISOString().slice(0, 10),
      visitors,
      revenue,
    });
  }
  for (const m of metrics) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [m.day, m.visitors, m.revenue]
    );
  }

  // 6 categories including a deliberately long label and a >= 1,000,000 value.
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284500 },
    { name: 'Marketing', value: 642300 },
    { name: 'Sales', value: 521900 },
    { name: 'Support', value: 318750 },
    { name: 'Research', value: 204120 },
    { name: 'Operations', value: 156400 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // 20 recent items.
  const names = [
    'Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Stark Industries',
    'Wayne Enterprises', 'Wonka', 'Cyberdyne', 'Hooli', 'Pied Piper',
    'Soylent', 'Massive Dynamic', 'Tyrell', 'Aperture', 'Black Mesa',
    'Oscorp', 'Gekko & Co', 'Vandelay', 'Sterling Cooper', 'Dunder Mifflin',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const created = new Date(today);
    created.setUTCDate(today.getUTCDate() - i);
    created.setUTCHours(9 + (i % 8), (i * 7) % 60, 0, 0);
    const value = +(500 + rand() * 9500).toFixed(2);
    const category = catNames[Math.floor(rand() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [names[i], category, value, created.toISOString()]
    );
  }

  await db.query("INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING");
}
