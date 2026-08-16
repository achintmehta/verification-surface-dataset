/**
 * db.js — PGLite initialisation, schema creation, and deterministic seed.
 *
 * Seed strategy
 * ─────────────
 * We use a simple linear-congruential PRNG seeded with a fixed constant so
 * every cold start produces identical data.  The PRNG is only used during the
 * seed phase; normal queries hit the real PGLite engine.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, 'data', 'pglite');

// ── PRNG ──────────────────────────────────────────────────────────────────────
// LCG parameters from Numerical Recipes (m=2^32, a=1664525, c=1013904223)
function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s = ((Math.imul(1664525, s) + 1013904223) >>> 0);
    return s / 0x100000000; // [0, 1)
  };
}

// ── Schema ────────────────────────────────────────────────────────────────────
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

-- Ensure the theme key always exists
INSERT INTO settings (key, value)
VALUES ('theme', 'light')
ON CONFLICT (key) DO NOTHING;
`;

// ── Seed data ─────────────────────────────────────────────────────────────────
async function seedIfEmpty(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM daily_metrics`
  );
  if (rows[0].n > 0) return; // already seeded

  const rng = makePrng(0xdeadbeef);

  // ── daily_metrics: 30 days ending yesterday ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr  = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 4500) + 500;          // 500–5000
    const revenue  = (rng() * 9000 + 1000).toFixed(2);        // 1000–10000
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, visitors, revenue]
    );
  }

  // ── categories: 6 rows, one long label, one value ≥ 1 000 000 ────────────
  const CATEGORIES = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_750.00 },
    { name: 'Cloud Services',   value: Math.floor(rng() * 80000) + 20000 },
    { name: 'Support & SLA',    value: Math.floor(rng() * 50000) + 10000 },
    { name: 'Professional Dev', value: Math.floor(rng() * 40000) +  5000 },
    { name: 'Licensing',        value: Math.floor(rng() * 30000) +  3000 },
    { name: 'Consulting',       value: Math.floor(rng() * 20000) +  1000 },
  ];
  for (const c of CATEGORIES) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [c.name, c.value]
    );
  }

  // ── recent_items: 20 rows ─────────────────────────────────────────────────
  const ITEM_NAMES = [
    'Acme Corp Renewal',      'Beta Launch Campaign',   'Cloud Migration Q3',
    'Data Warehouse Setup',   'Edge CDN Rollout',       'Firewall Audit',
    'GDPR Compliance Review', 'Helpdesk Tier-2 Bundle', 'IAM Policy Update',
    'Jenkins Pipeline Build', 'Kubernetes Cluster',     'Load Balancer Config',
    'Monitoring Stack',       'Network Segmentation',   'OAuth Integration',
    'Patch Management Cycle', 'QA Automation Suite',    'Redis Cache Layer',
    'Security Pen-Test',      'TLS Certificate Renewal',
  ];
  const CAT_NAMES = CATEGORIES.map(c => c.name);

  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const name     = ITEM_NAMES[i];
    const category = CAT_NAMES[Math.floor(rng() * CAT_NAMES.length)];
    const value    = (rng() * 49000 + 1000).toFixed(2);
    // spread created_at over the last 20 days
    const createdAt = new Date(now - i * 24 * 60 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at)
       VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt]
    );
  }

  console.log('[db] Seed complete.');
}

// ── Public init ───────────────────────────────────────────────────────────────
let _db = null;

export async function initDb() {
  if (_db) return _db;

  // Ensure the data directory exists
  const { mkdirSync } = await import('fs');
  mkdirSync(path.join(__dirname, 'data'), { recursive: true });

  _db = new PGlite(DB_PATH);
  await _db.waitReady;

  await _db.exec(SCHEMA_SQL);
  await seedIfEmpty(_db);

  console.log('[db] Ready at', DB_PATH);
  return _db;
}

export function getDb() {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}
