import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PGLite persists to the local file system so the seed and any settings
// changes survive a full server restart.
const DATA_DIR = path.join(__dirname, '..', '.pgdata');

/**
 * A small deterministic PRNG (mulberry32) so the seed is identical on every
 * fresh boot. Any two correct implementations render comparable dashboards.
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

let dbPromise = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = new PGlite(DATA_DIR);
      await migrate(db);
      await seed(db);
      return db;
    })();
  }
  return dbPromise;
}

async function migrate(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      day        DATE PRIMARY KEY,
      visitors   INTEGER NOT NULL,
      revenue    NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL,
      value BIGINT NOT NULL
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
      theme TEXT NOT NULL DEFAULT 'light',
      CONSTRAINT settings_singleton CHECK (id = 1)
    );
  `);
}

async function seed(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_metrics');
  if (rows[0].n > 0) {
    // Already seeded; just make sure settings row exists.
    await db.exec(`INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`);
    return;
  }

  const rand = mulberry32(1337);

  // ---- daily_metrics: 30 days ending today (deterministic shape) ----
  const days = 30;
  const today = new Date('2024-06-30T00:00:00Z');
  const dailyRows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    // Base trend + weekly seasonality + deterministic noise.
    const idx = days - 1 - i;
    const base = 1200 + idx * 18;
    const weekly = Math.sin((idx / 7) * Math.PI * 2) * 220;
    const noise = (rand() - 0.5) * 180;
    const visitors = Math.max(200, Math.round(base + weekly + noise));
    const revenue = Math.round(visitors * (4.2 + rand() * 2.6) * 100) / 100;
    dailyRows.push({ dayStr, visitors, revenue });
  }
  for (const r of dailyRows) {
    await db.query(
      'INSERT INTO daily_metrics (day, visitors, revenue) VALUES ($1, $2, $3)',
      [r.dayStr, r.visitors, r.revenue]
    );
  }

  // ---- categories: 6 rows, one long label, one value >= 1,000,000 ----
  const categories = [
    { name: 'Direct', value: 482030 },
    { name: 'Organic Search', value: 731544 },
    { name: 'Enterprise Infrastructure & Compliance', value: 1284902 },
    { name: 'Social', value: 263118 },
    { name: 'Referral', value: 158270 },
    { name: 'Email', value: 96540 },
  ];
  for (const c of categories) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [c.name, c.value]);
  }

  // ---- recent_items: 20 rows ----
  const catNames = categories.map((c) => c.name);
  const itemNouns = [
    'Acme Corp', 'Globex', 'Initech', 'Umbrella Co', 'Stark Industries',
    'Wayne Enterprises', 'Wonka Inc', 'Cyberdyne', 'Soylent', 'Hooli',
    'Pied Piper', 'Massive Dynamic', 'Tyrell Corp', 'Aperture', 'Black Mesa',
    'Oscorp', 'Gringotts', 'Nakatomi', 'Vandelay', 'Bluth Company',
  ];
  for (let i = 0; i < 20; i++) {
    const name = itemNouns[i];
    const category = catNames[Math.floor(rand() * catNames.length)];
    const value = Math.round((50 + rand() * 9500) * 100) / 100;
    const created = new Date(today);
    created.setUTCDate(today.getUTCDate() - Math.floor(rand() * 30));
    created.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, created.toISOString()]
    );
  }

  // ---- settings ----
  await db.exec(`INSERT INTO settings (id, theme) VALUES (1, 'light') ON CONFLICT (id) DO NOTHING;`);
}
