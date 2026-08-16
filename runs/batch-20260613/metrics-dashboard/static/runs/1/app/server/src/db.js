import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

mkdirSync(DATA_DIR, { recursive: true });

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(join(DATA_DIR, 'metrics.db'));
  await db.waitReady;
  return db;
}

export async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id        SERIAL PRIMARY KEY,
      date      DATE        NOT NULL UNIQUE,
      visitors  INTEGER     NOT NULL,
      revenue   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT          NOT NULL UNIQUE,
      value NUMERIC(14,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT          NOT NULL,
      category   TEXT          NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Deterministic pseudo-random number generator (mulberry32).
 * Returns a function that yields floats in [0, 1).
 */
function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedIfEmpty(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM daily_metrics`
  );
  if (rows[0].n > 0) return; // already seeded

  const rand = makePrng(0xdeadbeef);

  // ── daily_metrics: 30 days ending yesterday ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dailyRows = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(800 + rand() * 4200);   // 800–5000
    const revenue  = +(50 + rand() * 950).toFixed(2);   // 50–1000 per day
    dailyRows.push(`('${dateStr}', ${visitors}, ${revenue})`);
  }

  await db.exec(`
    INSERT INTO daily_metrics (date, visitors, revenue)
    VALUES ${dailyRows.join(',\n')}
    ON CONFLICT (date) DO NOTHING;
  `);

  // ── categories ────────────────────────────────────────────────────────────
  const categories = [
    ['Direct Sales',                          +(rand() * 500000 + 100000).toFixed(2)],
    ['Online Advertising',                    +(rand() * 300000 +  50000).toFixed(2)],
    ['Enterprise Infrastructure & Compliance', 1_234_567.89],   // long name + ≥7-digit value
    ['Partnerships',                          +(rand() * 200000 +  20000).toFixed(2)],
    ['Subscriptions',                         +(rand() * 400000 +  80000).toFixed(2)],
    ['Consulting Services',                   +(rand() * 150000 +  10000).toFixed(2)],
  ];

  const catValues = categories
    .map(([name, value]) => `('${name.replace(/'/g, "''")}', ${value})`)
    .join(',\n');

  await db.exec(`
    INSERT INTO categories (name, value)
    VALUES ${catValues}
    ON CONFLICT (name) DO NOTHING;
  `);

  // ── recent_items ──────────────────────────────────────────────────────────
  const itemNames = [
    'Alpha Project', 'Beta Campaign', 'Gamma Initiative', 'Delta Program',
    'Epsilon Deal', 'Zeta Contract', 'Eta Proposal', 'Theta Agreement',
    'Iota Package', 'Kappa Bundle', 'Lambda Suite', 'Mu Platform',
    'Nu Service', 'Xi Solution', 'Omicron Plan', 'Pi Offering',
    'Rho Product', 'Sigma Module', 'Tau Feature', 'Upsilon Release',
  ];
  const catNames = categories.map(([n]) => n);

  const itemRows = itemNames.map((name, idx) => {
    const cat = catNames[Math.floor(rand() * catNames.length)];
    const value = +(rand() * 9999 + 1).toFixed(2);
    // spread created_at over the last 20 days
    const daysAgo = 20 - idx;
    const ts = new Date(today);
    ts.setDate(ts.getDate() - daysAgo);
    return `('${name}', '${cat.replace(/'/g, "''")}', ${value}, '${ts.toISOString()}')`;
  });

  await db.exec(`
    INSERT INTO recent_items (name, category, value, created_at)
    VALUES ${itemRows.join(',\n')};
  `);

  // ── settings ──────────────────────────────────────────────────────────────
  await db.exec(`
    INSERT INTO settings (key, value)
    VALUES ('theme', 'light')
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log('[db] Seed complete.');
}
