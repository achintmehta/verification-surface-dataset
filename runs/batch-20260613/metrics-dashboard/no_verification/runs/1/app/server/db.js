import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data', 'pglite');

// ── Deterministic pseudo-random (seeded LCG) ─────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    // LCG parameters from Numerical Recipes
    s = Math.imul(1664525, s) + 1013904223;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

export async function initDb() {
  mkdirSync(DATA_DIR, { recursive: true });

  const db = new PGlite(DATA_DIR);

  // ── Schema ────────────────────────────────────────────────────────────────
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date      DATE        PRIMARY KEY,
      visitors  INTEGER     NOT NULL,
      revenue   NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL      PRIMARY KEY,
      name  TEXT        NOT NULL UNIQUE,
      value BIGINT      NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL      PRIMARY KEY,
      name       TEXT        NOT NULL,
      category   TEXT        NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      id    INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT    NOT NULL    DEFAULT 'light',
      CHECK (id = 1)
    );

    INSERT INTO settings (id, theme) VALUES (1, 'light')
      ON CONFLICT (id) DO NOTHING;
  `);

  // ── Check if already seeded ───────────────────────────────────────────────
  const check = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM daily_metrics`
  );
  if (Number(check.rows[0].cnt) > 0) {
    console.log('Database already seeded — skipping seed.');
    return db;
  }

  console.log('Seeding database…');
  const rng = makeRng(0xdeadbeef);

  // ── Seed daily_metrics (30 days ending yesterday) ─────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i - 1);
    const dateStr = d.toISOString().slice(0, 10);

    // visitors: 800–4000
    const visitors = 800 + Math.floor(rng() * 3200);
    // revenue: visitors * $8–$25 per visitor
    const revenue = (visitors * (8 + rng() * 17)).toFixed(2);

    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)
       ON CONFLICT (date) DO NOTHING`,
      [dateStr, visitors, revenue]
    );
  }

  // ── Seed categories (6 rows) ──────────────────────────────────────────────
  const categoryDefs = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_500 },
    { name: 'Cloud Services',                         value: 847_200  },
    { name: 'Professional Services',                  value: 523_900  },
    { name: 'Support & Maintenance',                  value: 312_750  },
    { name: 'Training & Certification',               value: 198_400  },
    { name: 'Consulting',                             value: 95_600   },
  ];

  for (const cat of categoryDefs) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [cat.name, cat.value]
    );
  }

  // ── Seed recent_items (20 rows) ───────────────────────────────────────────
  const itemNames = [
    'Acme Corp Renewal',
    'Beta Systems Upgrade',
    'Gamma Ltd Onboarding',
    'Delta Networks Audit',
    'Epsilon Cloud Migration',
    'Zeta Compliance Review',
    'Eta Infrastructure Setup',
    'Theta Support Contract',
    'Iota Training Bundle',
    'Kappa Consulting Retainer',
    'Lambda Security Assessment',
    'Mu Data Center Expansion',
    'Nu DevOps Transformation',
    'Xi Analytics Platform',
    'Omicron API Integration',
    'Pi Disaster Recovery Plan',
    'Rho Performance Tuning',
    'Sigma Cost Optimization',
    'Tau Vendor Management',
    'Upsilon Roadmap Workshop',
  ];

  const catNames = categoryDefs.map((c) => c.name);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[Math.floor(rng() * catNames.length)];
    const value = (500 + rng() * 49500).toFixed(2);

    // created_at: spread over last 30 days
    const daysAgo = Math.floor(rng() * 30);
    const hoursAgo = Math.floor(rng() * 24);
    const createdAt = new Date(today);
    createdAt.setDate(createdAt.getDate() - daysAgo);
    createdAt.setHours(createdAt.getHours() - hoursAgo);

    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at)
       VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  console.log('Seeding complete.');
  return db;
}
