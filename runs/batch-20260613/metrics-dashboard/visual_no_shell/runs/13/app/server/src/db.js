import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Persist PGLite to the local file system so data survives a full server restart.
const DATA_DIR = join(__dirname, '..', 'pgdata');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new PGlite(DATA_DIR);

/**
 * Deterministic pseudo-random generator (mulberry32) seeded with a fixed value
 * so any two boots produce identical seed data.
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

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day        DATE PRIMARY KEY,
      visitors   INTEGER NOT NULL,
      revenue    NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL,
      value  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id    INTEGER PRIMARY KEY DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'light'
    );
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM daily_metrics');
  if (rows[0].c > 0) {
    // Already seeded.
    await ensureSettings();
    return;
  }

  await seed();
  await ensureSettings();
}

async function ensureSettings() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM settings');
  if (rows[0].c === 0) {
    await db.query('INSERT INTO settings (id, theme) VALUES (1, $1)', ['light']);
  }
}

async function seed() {
  const rand = mulberry32(20240601);

  // ---- 30 days of daily metrics (oldest first) ----
  // Anchor on a fixed end date so the seed is fully deterministic.
  const endDate = new Date(Date.UTC(2024, 5, 30)); // 2024-06-30
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(endDate);
    d.setUTCDate(endDate.getUTCDate() - i);
    // Smooth-ish series with deterministic noise and a mild upward trend.
    const base = 800 + (29 - i) * 18;
    const noise = Math.floor((rand() - 0.5) * 320);
    const visitors = Math.max(120, base + noise);
    const revenue = +(visitors * (4 + rand() * 6)).toFixed(2);
    days.push({ day: fmtDate(d), visitors, revenue });
  }
  for (const r of days) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [r.day, r.visitors, r.revenue]
    );
  }

  // ---- 6 categories (one long label, one value >= 1,000,000) ----
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1284500 },
    { name: 'Marketing', value: 642300 },
    { name: 'Sales', value: 531900 },
    { name: 'Support', value: 318750 },
    { name: 'Research & Development', value: 274100 },
    { name: 'Operations', value: 156400 }
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // ---- 20 recent items ----
  const itemNames = [
    'Acme Subscription Renewal', 'Northwind Onboarding', 'Globex Annual Plan',
    'Initech Upgrade', 'Umbrella Add-on', 'Stark Industries License',
    'Wayne Enterprises Seat', 'Wonka Premium', 'Hooli Migration',
    'Pied Piper Trial', 'Soylent Bulk Order', 'Cyberdyne Support',
    'Tyrell Expansion', 'Oscorp Consulting', 'Vandelay Import',
    'Gekko Holdings Plan', 'Bluth Company Setup', 'Dunder Mifflin Renewal',
    'Sterling Cooper Retainer', 'Prestige Worldwide Deal'
  ];
  const catNames = categories.map((c) => c.name);
  const recentEnd = new Date(Date.UTC(2024, 5, 30, 12, 0, 0));
  for (let i = 0; i < 20; i++) {
    const created = new Date(recentEnd);
    created.setUTCHours(recentEnd.getUTCHours() - i * 7);
    const value = +(120 + rand() * 9800).toFixed(2);
    const category = catNames[Math.floor(rand() * catNames.length)];
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [itemNames[i], category, value, created.toISOString()]
    );
  }
}
