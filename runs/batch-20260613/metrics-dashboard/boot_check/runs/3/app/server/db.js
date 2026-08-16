import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_DIR = join(__dirname, '..', 'data', 'pglite');

// Simple seeded pseudo-random number generator (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function initDb() {
  mkdirSync(DB_DIR, { recursive: true });

  const db = new PGlite(DB_DIR);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INTEGER NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
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
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS cnt FROM daily_metrics'
  );
  const alreadySeeded = parseInt(countRows[0].cnt, 10) > 0;

  if (!alreadySeeded) {
    console.log('Seeding database...');
    await seed(db);
    console.log('Seeding complete.');
  } else {
    console.log('Database already seeded, skipping.');
  }

  return db;
}

async function seed(db) {
  const rand = mulberry32(42);

  // ── daily_metrics: 30 days ending yesterday ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    // visitors: 800–4800
    const visitors = Math.floor(rand() * 4000) + 800;
    // revenue: 500–9500
    const revenue = (rand() * 9000 + 500).toFixed(2);

    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3) ON CONFLICT (date) DO NOTHING',
      [dateStr, visitors, revenue]
    );
  }

  // ── categories ────────────────────────────────────────────────────────────
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_250_000 },
    { name: 'Cloud Services',                         value: 874_320 },
    { name: 'Professional Services',                  value: 563_100 },
    { name: 'Support & Maintenance',                  value: 341_750 },
    { name: 'Training & Certification',               value: 198_400 },
    { name: 'Consulting',                             value: 87_650 },
  ];

  for (const cat of categories) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [cat.name, cat.value]
    );
  }

  // ── recent_items: 20 rows ─────────────────────────────────────────────────
  const itemNames = [
    'Project Alpha', 'Project Beta', 'Project Gamma', 'Project Delta',
    'Project Epsilon', 'Project Zeta', 'Project Eta', 'Project Theta',
    'Project Iota', 'Project Kappa', 'Project Lambda', 'Project Mu',
    'Project Nu', 'Project Xi', 'Project Omicron', 'Project Pi',
    'Project Rho', 'Project Sigma', 'Project Tau', 'Project Upsilon',
  ];

  const catNames = categories.map((c) => c.name);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = (rand() * 50000 + 1000).toFixed(2);
    const daysAgo = Math.floor(rand() * 30);
    const createdAt = new Date(today);
    createdAt.setDate(createdAt.getDate() - daysAgo);

    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt.toISOString()]
    );
  }

  // ── settings ──────────────────────────────────────────────────────────────
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING"
  );
}
