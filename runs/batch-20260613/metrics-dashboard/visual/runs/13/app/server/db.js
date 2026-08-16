import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'pgdata');

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

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
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
      created_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      theme TEXT NOT NULL DEFAULT 'light'
    );
  `);
}

async function seedIfEmpty(db) {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (res.rows[0].c > 0) {
    // Ensure settings row exists regardless.
    await db.exec(`INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`);
    return;
  }

  const rand = mulberry32(1337);

  // --- daily_metrics: 30 days ending today ---
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    // Smooth-ish wave plus noise for realistic-looking series.
    const base = 1200 + Math.sin(i / 4) * 350;
    const visitors = Math.round(base + rand() * 500);
    const revenue = Math.round((visitors * (8 + rand() * 6)) * 100) / 100;
    days.push({ date: iso, visitors, revenue });
  }
  for (const d of days) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [d.date, d.visitors, d.revenue]
    );
  }

  // --- categories: 6 rows incl. one long label and one value >= 1,000,000 ---
  const categories = [
    { name: 'Direct', value: 482301 },
    { name: 'Organic Search', value: 731902 },
    { name: 'Referral', value: 298145 },
    { name: 'Social Media', value: 410588 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284673 },
    { name: 'Email', value: 156432 }
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // --- recent_items: 20 rows ---
  const itemNames = [
    'Quarterly revenue export', 'Onboarding flow update', 'Pricing experiment B',
    'Churn analysis report', 'API latency audit', 'Mobile redesign rollout',
    'Data pipeline migration', 'Security compliance review', 'Customer NPS survey',
    'Feature flag cleanup', 'Billing reconciliation', 'Dashboard refresh',
    'Cohort retention study', 'Marketing attribution model', 'Support ticket triage',
    'Inventory forecast run', 'Partner integration sync', 'Localization pass EU',
    'Performance regression fix', 'Annual planning summary'
  ];
  const catNames = categories.map((c) => c.name);
  for (let i = 0; i < 20; i++) {
    const created = new Date(today);
    created.setUTCDate(today.getUTCDate() - Math.floor(rand() * 30));
    created.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    const value = Math.round((500 + rand() * 95000) * 100) / 100;
    const category = catNames[Math.floor(rand() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, created.toISOString()]
    );
  }

  // --- settings ---
  await db.exec(`INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`);
}
