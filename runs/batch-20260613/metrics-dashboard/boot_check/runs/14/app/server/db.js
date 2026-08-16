import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

// Deterministic PRNG (mulberry32) so the seed is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
      day DATE PRIMARY KEY,
      visitors INTEGER NOT NULL,
      revenue NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function seed(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (rows[0].c > 0) return; // already seeded

  const rand = mulberry32(20240117);

  // --- daily_metrics: 30 days ending today ---
  const today = new Date(Date.UTC(2024, 0, 30)); // fixed reference date for determinism
  const metrics = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    const base = 800 + Math.floor(rand() * 1200);
    const wave = Math.round(300 * Math.sin((29 - i) / 4));
    const visitors = Math.max(120, base + wave);
    const revenue = Math.round((visitors * (3 + rand() * 9)) * 100) / 100;
    metrics.push({ day: dayStr, visitors, revenue });
  }
  for (const m of metrics) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [m.day, m.visitors, m.revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ---
  const categories = [
    { name: 'Direct Traffic', value: 482300 },
    { name: 'Organic Search', value: 731950 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284560 },
    { name: 'Paid Social', value: 215400 },
    { name: 'Email Campaigns', value: 98720 },
    { name: 'Referral Partners', value: 342110 }
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // --- recent_items: 20 rows ---
  const itemNames = [
    'Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Stark Industries',
    'Wayne Enterprises', 'Wonka', 'Cyberdyne', 'Soylent', 'Hooli',
    'Pied Piper', 'Aviato', 'Massive Dynamic', 'Vehement Capital', 'Vandelay',
    'Gekko & Co', 'Bluth Company', 'Dunder Mifflin', 'Prestige Worldwide', 'Sterling Cooper'
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((50 + rand() * 9950) * 100) / 100;
    const created = new Date(today);
    created.setUTCDate(today.getUTCDate() - Math.floor(rand() * 30));
    created.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // --- settings ---
  await db.query("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING");
}
