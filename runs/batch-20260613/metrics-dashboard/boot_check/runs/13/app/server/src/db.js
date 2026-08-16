import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PGLite persisted to the local file system.
const DATA_DIR = path.join(__dirname, '..', 'data', 'pgdata');

let db;

/**
 * A tiny deterministic PRNG (mulberry32) so the seed is identical on every
 * first boot regardless of platform.
 */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Build the deterministic dataset.
 * - 30 days of daily metrics (date, visitors, revenue)
 * - 6 categories (one deliberately long label, one value >= 1,000,000)
 * - 20 recent items
 */
function buildSeedData() {
  const rand = mulberry32(1234567);

  // Anchor the date range to a fixed end date so the seed is deterministic.
  const endDate = new Date(Date.UTC(2024, 5, 30)); // 2024-06-30

  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(endDate);
    d.setUTCDate(endDate.getUTCDate() - i);
    const dateStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate()
    )}`;
    // Visitors: trend upward gently with noise.
    const base = 800 + (29 - i) * 18;
    const visitors = Math.round(base + (rand() - 0.5) * 400);
    const revenue = Math.round(visitors * (3 + rand() * 4) * 100) / 100;
    daily.push({ date: dateStr, visitors, revenue });
  }

  const categoryNames = [
    'Direct',
    'Organic Search',
    'Paid Social',
    'Email Campaigns',
    'Referral Partners',
    'Enterprise Infrastructure & Compliance',
  ];
  const categories = categoryNames.map((name, idx) => {
    // Make the long enterprise label the >= 1,000,000 value.
    let value;
    if (name === 'Enterprise Infrastructure & Compliance') {
      value = 1480000 + Math.round(rand() * 200000);
    } else {
      value = 20000 + Math.round(rand() * 180000);
    }
    return { name, value };
  });

  const itemNames = [
    'Quarterly Performance Report',
    'New User Onboarding Flow',
    'Checkout Funnel Optimization',
    'Mobile App Release 4.2',
    'API Rate Limit Adjustment',
    'Marketing Landing Page',
    'Customer Feedback Survey',
    'Inventory Sync Job',
    'Billing Reconciliation',
    'Search Index Rebuild',
    'Dashboard Widget Refactor',
    'Email Deliverability Audit',
    'Partner Integration Webhook',
    'Data Warehouse Migration',
    'Fraud Detection Tuning',
    'Localization Pass (de-DE)',
    'Accessibility Compliance Review',
    'Cache Warming Strategy',
    'Subscription Renewal Reminders',
    'Enterprise SSO Rollout',
  ];

  const recent = [];
  for (let i = 0; i < 20; i++) {
    const cat = categoryNames[Math.floor(rand() * categoryNames.length)];
    const value = Math.round((50 + rand() * 9950) * 100) / 100;
    const d = new Date(endDate);
    d.setUTCDate(endDate.getUTCDate() - Math.floor(rand() * 29));
    d.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    recent.push({
      name: itemNames[i],
      category: cat,
      value,
      created_at: d.toISOString(),
    });
  }
  // Sort recent newest first.
  recent.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return { daily, categories, recent };
}

async function ensureSchema() {
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
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function seedIfEmpty() {
  const res = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (res.rows[0].c > 0) return;

  const { daily, categories, recent } = buildSeedData();

  for (const row of daily) {
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [row.date, row.visitors, row.revenue]
    );
  }
  for (const row of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [
      row.name,
      row.value,
    ]);
  }
  for (const row of recent) {
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [row.name, row.category, row.value, row.created_at]
    );
  }

  // Default theme setting.
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );
}

export async function initDb() {
  if (db) return db;
  // PGLite's node FS does not create intermediate directories, so ensure the
  // parent path exists before opening the database.
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await ensureSchema();
  // Ensure theme setting exists even if other tables were already seeded.
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );
  await seedIfEmpty();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
