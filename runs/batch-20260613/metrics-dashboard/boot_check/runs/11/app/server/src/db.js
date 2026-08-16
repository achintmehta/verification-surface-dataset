import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

/**
 * A small deterministic PRNG (mulberry32) so the seed is reproducible across
 * boots and across correct implementations.
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

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

let db;

export async function getDb() {
  if (db) return db;
  db = await PGlite.create(DATA_DIR);
  await migrate(db);
  await seed(db);
  return db;
}

async function migrate(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day        DATE PRIMARY KEY,
      visitors   INTEGER NOT NULL,
      revenue    NUMERIC(12,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      value      BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id    INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'light',
      CONSTRAINT settings_singleton CHECK (id = 1)
    );
  `);
}

async function seed(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) {
    // Ensure settings row exists even if data already seeded.
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING`
    );
    return;
  }

  const rand = mulberry32(20240517);

  // --- daily_metrics: 30 days ending "today" (fixed anchor for determinism) ---
  // Use a fixed anchor date so the seeded values are reproducible.
  const anchor = new Date('2024-05-30T00:00:00Z');
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    // Visitors: smooth-ish wave + noise, always positive.
    const base = 1800 + Math.round(Math.sin(i / 3) * 400);
    const visitors = Math.max(200, base + Math.round((rand() - 0.5) * 600));
    // Revenue roughly proportional to visitors with variance.
    const revenue = +(visitors * (3 + rand() * 4)).toFixed(2);
    days.push({ day: ymd(d), visitors, revenue });
  }
  for (const r of days) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [r.day, r.visitors, r.revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value >= 1,000,000 ---
  const categories = [
    { name: 'Direct', value: 482_300 },
    { name: 'Organic Search', value: 731_540 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_905 },
    { name: 'Referral', value: 219_870 },
    { name: 'Social', value: 356_120 },
    { name: 'Email', value: 168_450 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      c.name,
      c.value,
    ]);
  }

  // --- recent_items: 20 rows ---
  const itemNouns = [
    'Subscription', 'Upgrade', 'License', 'Add-on', 'Renewal',
    'Trial Conversion', 'Seat Expansion', 'Support Plan', 'Migration', 'Onboarding',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const noun = itemNouns[Math.floor(rand() * itemNouns.length)];
    const name = `${noun} #${1000 + i}`;
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = +(50 + rand() * 9950).toFixed(2);
    const created = new Date(anchor);
    created.setUTCHours(anchor.getUTCHours() - i * 7 - Math.floor(rand() * 5));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // --- settings ---
  await db.query(
    `INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING`
  );
}
