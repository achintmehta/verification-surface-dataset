import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

// A small deterministic PRNG (mulberry32) so seeding is reproducible across
// boots and across any two correct implementations using the same seed.
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

let db;

export async function getDb() {
  if (db) return db;
  db = await PGlite.create(DATA_DIR);
  await initSchema(db);
  await seedIfEmpty(db);
  return db;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
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
  const res = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (res.rows[0].n > 0) {
    // Still make sure a settings row exists.
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, 'light')
       ON CONFLICT (id) DO NOTHING`
    );
    return;
  }

  const rand = mulberry32(1337);

  // --- daily_metrics: 30 days ending today (deterministic walk) ---
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let visitors = 1200;
  let revenue = 8400;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    // gentle random walk with slight upward drift
    visitors = Math.max(200, Math.round(visitors + (rand() - 0.45) * 220));
    revenue = Math.max(500, Math.round((revenue + (rand() - 0.44) * 1600) * 100) / 100);
    const dateStr = d.toISOString().slice(0, 10);
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ---
  const categories = [
    ['Direct', 482300],
    ['Organic Search', 731940],
    ['Enterprise Infrastructure & Compliance', 1284560],
    ['Social', 263110],
    ['Referral', 198450],
    ['Email', 354720]
  ];
  for (const [name, value] of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
  }

  // --- recent_items: 20 rows ---
  const catNames = categories.map((c) => c[0]);
  const sampleNames = [
    'Acme Corp', 'Globex', 'Initech', 'Umbrella Co', 'Stark Industries',
    'Wayne Enterprises', 'Wonka Industries', 'Cyberdyne', 'Soylent', 'Hooli',
    'Pied Piper', 'Massive Dynamic', 'Tyrell Corp', 'Oscorp', 'Nakatomi',
    'Gekko & Co', 'Vandelay', 'Bluth Company', 'Dunder Mifflin', 'Prestige Worldwide'
  ];
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const name = sampleNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((300 + rand() * 9700) * 100) / 100;
    const created = new Date(now - Math.floor(rand() * 20 * 24 * 3600 * 1000));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // --- settings ---
  await db.query(
    `INSERT INTO settings (id, theme) VALUES (1, 'light')
     ON CONFLICT (id) DO NOTHING`
  );
}
