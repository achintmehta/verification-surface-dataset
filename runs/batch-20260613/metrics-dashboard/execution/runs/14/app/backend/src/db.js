import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

let dbInstance = null;

/**
 * A small deterministic pseudo-random generator (mulberry32).
 * Guarantees the seed produces the same dataset on every fresh boot.
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

function toDateString(d) {
  return d.toISOString().slice(0, 10);
}

export async function getDb() {
  if (dbInstance) return dbInstance;

  const db = new PGlite(DATA_DIR);
  await db.waitReady;

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
      id INTEGER PRIMARY KEY,
      theme TEXT NOT NULL
    );
  `);

  await seedIfEmpty(db);

  dbInstance = db;
  return db;
}

async function seedIfEmpty(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (rows[0].c > 0) return;

  const rand = mulberry32(20240517);

  // ---- daily_metrics: 30 days ending today (deterministic) ----
  // Use a fixed anchor date so the seed is fully deterministic.
  const anchor = new Date('2024-05-30T00:00:00.000Z');
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const base = 1200 + Math.floor(rand() * 2600); // 1200..3800
    const visitors = base;
    const revenue = Math.round((base * (3 + rand() * 9)) * 100) / 100; // revenue tied to visitors
    days.push({ day: toDateString(d), visitors, revenue });
  }

  for (const row of days) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [row.day, row.visitors, row.revenue]
    );
  }

  // ---- categories: 6 rows, incl. a long label and one value >= 1,000,000 ----
  const categories = [
    { name: 'Direct', value: 482_000 },
    { name: 'Organic Search', value: 731_500 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_930 },
    { name: 'Referral', value: 214_300 },
    { name: 'Social', value: 356_780 },
    { name: 'Email', value: 128_640 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // ---- recent_items: 20 rows ----
  const itemNouns = [
    'Acme Corp Renewal', 'North Star Upgrade', 'BlueOcean License', 'Quantum Migration',
    'Helios Onboarding', 'Vertex Expansion', 'Pioneer Add-on', 'Summit Subscription',
    'Atlas Integration', 'Nimbus Trial Conversion', 'Forge Annual Plan', 'Cascade Seat Bump',
    'Beacon Pro Tier', 'Orbit Enterprise Deal', 'Lumen Support Pack', 'Delta Renewal',
    'Echo Platform Plan', 'Falcon Premium', 'Granite Volume Order', 'Harbor Starter Plan',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNouns[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((50 + rand() * 9950) * 100) / 100;
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - Math.floor(rand() * 30));
    d.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, d.toISOString()]
    );
  }

  // ---- settings ----
  await db.query('INSERT INTO settings (id, theme) VALUES (1, $1)', ['light']);
}
