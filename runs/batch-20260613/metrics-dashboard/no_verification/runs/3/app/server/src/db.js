import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../.pglite-data');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  return db;
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-random number generator (seeded)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS daily_metrics (
  id         SERIAL PRIMARY KEY,
  date       DATE        NOT NULL UNIQUE,
  visitors   INTEGER     NOT NULL,
  revenue    NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL UNIQUE,
  value      BIGINT      NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_items (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  category   TEXT        NOT NULL,
  value      NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
async function seedIfEmpty(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM daily_metrics`
  );
  if (rows[0].cnt > 0) return; // already seeded

  const rand = mulberry32(0xdeadbeef);

  // ---- daily_metrics: 30 days ending yesterday ----
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rand() * 4000) + 500;   // 500–4499
    const revenue = (rand() * 9000 + 1000).toFixed(2);  // 1000–10000
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)
       ON CONFLICT (date) DO NOTHING`,
      [dateStr, visitors, revenue]
    );
  }

  // ---- categories: 6 rows, one long label, one value ≥ 1,000,000 ----
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_500 },
    { name: 'Cloud Services',                         value: Math.floor(rand() * 500_000) + 200_000 },
    { name: 'Professional Services',                  value: Math.floor(rand() * 300_000) + 100_000 },
    { name: 'Support & Maintenance',                  value: Math.floor(rand() * 200_000) + 50_000  },
    { name: 'Training & Certification',               value: Math.floor(rand() * 100_000) + 20_000  },
    { name: 'Consulting',                             value: Math.floor(rand() * 80_000)  + 10_000  },
  ];

  for (const cat of categories) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [cat.name, cat.value]
    );
  }

  // ---- recent_items: 20 rows ----
  const itemNames = [
    'Acme Corp Renewal', 'Beta Systems Upgrade', 'Gamma Analytics Suite',
    'Delta Cloud Migration', 'Epsilon Security Audit', 'Zeta Compliance Review',
    'Eta Performance Boost', 'Theta Data Pipeline', 'Iota API Integration',
    'Kappa Dashboard Setup', 'Lambda Reporting Tool', 'Mu Backup Solution',
    'Nu Monitoring Stack', 'Xi Alerting System', 'Omicron Log Aggregator',
    'Pi Workflow Engine', 'Rho Identity Provider', 'Sigma CDN Config',
    'Tau Load Balancer', 'Upsilon Cache Layer',
  ];

  const catNames = categories.map((c) => c.name);

  const baseTime = new Date(today);
  baseTime.setDate(baseTime.getDate() - 20);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = (rand() * 50_000 + 500).toFixed(2);
    const createdAt = new Date(baseTime.getTime() + i * 86_400_000 * rand());
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at)
       VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  // ---- settings: default theme ----
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );

  console.log('[db] Seed complete.');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export async function initDb() {
  const db = await getDb();
  await db.exec(SCHEMA_SQL);
  await seedIfEmpty(db);
  console.log('[db] Ready.');
  return db;
}
