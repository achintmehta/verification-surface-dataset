import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'pglite');

// ---------------------------------------------------------------------------
// Deterministic pseudo-random number generator (mulberry32)
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
  id    SERIAL PRIMARY KEY,
  name  TEXT          NOT NULL UNIQUE,
  value NUMERIC(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_items (
  id         SERIAL PRIMARY KEY,
  name       TEXT          NOT NULL,
  category   TEXT          NOT NULL,
  value      NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seed_done (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE
);
`;

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
async function seed(db) {
  // Guard: only seed once
  const check = await db.query('SELECT id FROM seed_done LIMIT 1');
  if (check.rows.length > 0) return;

  const rand = mulberry32(0xdeadbeef);

  // --- daily_metrics: 30 days ending yesterday ---
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i - 1);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rand() * 4500) + 500;   // 500–5000
    const revenue = (rand() * 9000 + 1000).toFixed(2);  // 1000–10000
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // --- categories: 6 rows, one long label, one value ≥ 1,000,000 ---
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_250_000.00 },
    { name: 'Cloud Services',                         value: Math.floor(rand() * 80000) + 20000 },
    { name: 'Professional Services',                  value: Math.floor(rand() * 60000) + 15000 },
    { name: 'Support & Maintenance',                  value: Math.floor(rand() * 40000) + 10000 },
    { name: 'Training & Certification',               value: Math.floor(rand() * 30000) + 5000  },
    { name: 'Consulting',                             value: Math.floor(rand() * 25000) + 3000  },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  // --- recent_items: 20 rows ---
  const catNames = categories.map((c) => c.name);
  const itemNames = [
    'Project Alpha', 'Project Beta', 'Project Gamma', 'Project Delta',
    'Project Epsilon', 'Project Zeta', 'Project Eta', 'Project Theta',
    'Project Iota', 'Project Kappa', 'Project Lambda', 'Project Mu',
    'Project Nu', 'Project Xi', 'Project Omicron', 'Project Pi',
    'Project Rho', 'Project Sigma', 'Project Tau', 'Project Upsilon',
  ];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = (rand() * 50000 + 500).toFixed(2);
    const daysAgo = Math.floor(rand() * 30);
    const createdAt = new Date(today);
    createdAt.setDate(createdAt.getDate() - daysAgo);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // --- settings: default theme ---
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );

  // Mark seed done
  await db.query('INSERT INTO seed_done (id) VALUES (TRUE) ON CONFLICT DO NOTHING');

  console.log('Database seeded successfully.');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export async function initDb() {
  mkdirSync(DATA_DIR, { recursive: true });

  const db = new PGlite(`file://${DATA_DIR}`);
  await db.waitReady;

  await db.exec(SCHEMA_SQL);
  await seed(db);

  return db;
}
