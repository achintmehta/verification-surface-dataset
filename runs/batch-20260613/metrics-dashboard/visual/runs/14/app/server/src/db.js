import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'pgdata');

/**
 * A small deterministic pseudo-random generator (mulberry32) so the seed is
 * stable across boots and across implementations.
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
      day        DATE PRIMARY KEY,
      visitors   INTEGER NOT NULL,
      revenue    NUMERIC NOT NULL
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
      value      NUMERIC NOT NULL,
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
    // Ensure settings row always exists.
    await db.query(
      `INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING`
    );
    return;
  }

  const rand = mulberry32(1337);

  // ----- daily_metrics: 30 days ending "today" (deterministic anchor) -----
  // Use a fixed anchor date so seeded data is fully deterministic.
  const anchor = new Date(Date.UTC(2024, 0, 30)); // 2024-01-30
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    // Smooth-ish wave with deterministic noise.
    const base = 1200 + Math.round(600 * Math.sin((i / 29) * Math.PI * 2));
    const visitors = Math.max(200, base + Math.round((rand() - 0.5) * 400));
    const revenue = Math.round((visitors * (8 + rand() * 6)) * 100) / 100;
    days.push({ dayStr, visitors, revenue });
  }
  for (const { dayStr, visitors, revenue } of days) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [dayStr, visitors, revenue]
    );
  }

  // ----- categories: 6 rows incl. a long label and a value >= 1,000,000 -----
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284530 },
    { name: 'Marketing', value: 642100 },
    { name: 'Direct Sales', value: 531800 },
    { name: 'Partnerships', value: 318450 },
    { name: 'Support', value: 192300 },
    { name: 'Research', value: 98750 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      c.name,
      c.value,
    ]);
  }

  // ----- recent_items: 20 rows -----
  const itemNames = [
    'Acme Renewal', 'Globex Onboarding', 'Initech License', 'Umbrella Upgrade',
    'Stark Expansion', 'Wayne Retainer', 'Wonka Bulk Order', 'Hooli Migration',
    'Pied Piper Trial', 'Cyberdyne Support', 'Soylent Consulting', 'Tyrell Audit',
    'Massive Dynamic Deal', 'Oscorp Pilot', 'Vandelay Export', 'Gekko Advisory',
    'Bluth Catering', 'Dunder Renewal', 'Sterling Campaign', 'Prestige Setup',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < itemNames.length; i++) {
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((500 + rand() * 49500) * 100) / 100;
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - Math.floor(rand() * 30));
    d.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, d.toISOString()]
    );
  }

  // ----- settings -----
  await db.query(
    `INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING`
  );
}
