import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PGLite persists to the local filesystem so the seeded data and the
// theme preference survive a full server restart.
const DATA_DIR = path.join(__dirname, '..', '.pgdata');

/**
 * A tiny deterministic PRNG (mulberry32) so the seed is reproducible:
 * any two boots produce the same dataset.
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
      revenue    INTEGER NOT NULL
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
      id    INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'light'
    );
  `);
}

async function seed(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) return; // already seeded — keep it deterministic & stable

  const rnd = mulberry32(20240217);

  // ---- daily_metrics: 30 consecutive days ending "today" (fixed anchor) ----
  // Use a fixed anchor date so seeded data is fully deterministic.
  const anchor = new Date('2024-06-30T00:00:00Z');
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    // Smooth-ish trending series with noise.
    const base = 1200 + (29 - i) * 18;
    const visitors = Math.round(base + (rnd() - 0.5) * 400);
    const revenue = Math.round(visitors * (8 + rnd() * 6));
    days.push({ dayStr, visitors: Math.max(200, visitors), revenue });
  }
  for (const row of days) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [row.dayStr, row.visitors, row.revenue]
    );
  }

  // ---- categories: 6 rows, one long label, one value >= 1,000,000 ----
  const categories = [
    { name: 'Search', value: 482_311 },
    { name: 'Direct', value: 351_209 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_905 },
    { name: 'Social', value: 198_440 },
    { name: 'Referral', value: 142_870 },
    { name: 'Email', value: 96_512 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      c.name,
      c.value,
    ]);
  }

  // ---- recent_items: 20 rows ----
  const itemNames = [
    'Onboarding flow update',
    'Q2 revenue report',
    'API rate-limit patch',
    'Dark mode rollout',
    'Checkout redesign',
    'Mobile nav fix',
    'Billing reconciliation',
    'Search relevance tuning',
    'Cache warmup job',
    'Email digest A/B test',
    'Compliance audit export',
    'Dashboard latency fix',
    'New pricing page',
    'Webhook retry logic',
    'User import tool',
    'Session timeout policy',
    'Referral bonus campaign',
    'Inventory sync service',
    'Analytics event schema',
    'Locale & i18n bundle',
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < itemNames.length; i++) {
    const created = new Date(anchor);
    created.setUTCHours(anchor.getUTCHours() - i * 7);
    const value = Math.round(500 + rnd() * 9500);
    const category = catNames[Math.floor(rnd() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, created.toISOString()]
    );
  }

  // ---- settings: single row ----
  await db.query(
    'INSERT INTO settings (id, theme) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
    ['light']
  );
}
