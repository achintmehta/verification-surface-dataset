/**
 * Database initialisation: PGLite embedded PostgreSQL.
 * Schema creation and deterministic seed run once on first boot.
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../.pglite-data');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DB_PATH);
  await db.waitReady;
  await initSchema();
  return db;
}

/* ------------------------------------------------------------------ */
/*  Deterministic pseudo-random number generator (mulberry32)          */
/* ------------------------------------------------------------------ */
function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/*  Schema + seed                                                       */
/* ------------------------------------------------------------------ */
async function initSchema() {
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id          SERIAL PRIMARY KEY,
      date        DATE        NOT NULL UNIQUE,
      visitors    INTEGER     NOT NULL,
      revenue     NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          SERIAL PRIMARY KEY,
      name        TEXT        NOT NULL UNIQUE,
      value       BIGINT      NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id          SERIAL PRIMARY KEY,
      name        TEXT        NOT NULL,
      category    TEXT        NOT NULL,
      value       NUMERIC(12,2) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL
    );
  `);

  // Only seed if tables are empty
  const { rows: dmRows } = await db.query('SELECT COUNT(*) AS c FROM daily_metrics');
  if (parseInt(dmRows[0].c, 10) > 0) return;

  const rand = makePrng(0xdeadbeef);

  /* ---- daily_metrics: 30 days ending yesterday ---- */
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rand() * 4500) + 500;          // 500–5000
    const revenue  = (rand() * 9000 + 1000).toFixed(2);        // 1000–10000
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  /* ---- categories: 6 rows ---- */
  const categoryDefs = [
    { name: 'Enterprise Infrastructure & Compliance', value: Math.floor(rand() * 500000) + 1000000 }, // ≥ 1,000,000
    { name: 'Cloud Services',   value: Math.floor(rand() * 400000) + 200000 },
    { name: 'Analytics',        value: Math.floor(rand() * 300000) + 150000 },
    { name: 'Security',         value: Math.floor(rand() * 250000) + 100000 },
    { name: 'Networking',       value: Math.floor(rand() * 200000) + 80000  },
    { name: 'Support',          value: Math.floor(rand() * 100000) + 20000  },
  ];

  for (const cat of categoryDefs) {
    await db.query(
      'INSERT INTO categories (name, value) VALUES ($1, $2)',
      [cat.name, cat.value]
    );
  }

  /* ---- recent_items: 20 rows ---- */
  const itemNames = [
    'Alpha Project', 'Beta Initiative', 'Gamma Rollout', 'Delta Upgrade',
    'Epsilon Review', 'Zeta Deployment', 'Eta Migration', 'Theta Audit',
    'Iota Refresh', 'Kappa Launch', 'Lambda Sync', 'Mu Patch',
    'Nu Release', 'Xi Hotfix', 'Omicron Build', 'Pi Snapshot',
    'Rho Backup', 'Sigma Restore', 'Tau Cleanup', 'Upsilon Archive',
  ];
  const catNames = categoryDefs.map(c => c.name);

  const baseTime = new Date(today);
  baseTime.setDate(baseTime.getDate() - 1);

  for (let i = 0; i < 20; i++) {
    const name     = itemNames[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value    = (rand() * 50000 + 100).toFixed(2);
    const hoursAgo = Math.floor(rand() * 72);
    const createdAt = new Date(baseTime.getTime() - hoursAgo * 3600000).toISOString();
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, createdAt]
    );
  }

  /* ---- settings: default theme ---- */
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`
  );

  console.log('[db] Seed complete.');
}
