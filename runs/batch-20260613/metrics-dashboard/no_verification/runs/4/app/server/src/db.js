import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../.pglite-data');

/**
 * Deterministic pseudo-random number generator (mulberry32).
 * Given the same seed it always produces the same sequence.
 */
function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0xdeadbeef;

function generateSeedData() {
  const rng = makePrng(SEED);

  // ── daily_metrics: 30 days ending yesterday ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dailyMetrics = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 4500) + 500;   // 500–5000
    const revenue = Math.floor(rng() * 9000) + 1000;   // 1000–10000
    dailyMetrics.push({ date: dateStr, visitors, revenue });
  }

  // ── categories: 6 rows, one long label, one value ≥ 1,000,000 ────────────
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: Math.floor(rng() * 500000) + 1000000 },
    { name: 'Cloud Services',                         value: Math.floor(rng() * 400000) + 200000 },
    { name: 'Analytics',                              value: Math.floor(rng() * 300000) + 100000 },
    { name: 'Security',                               value: Math.floor(rng() * 200000) + 80000  },
    { name: 'Developer Tools',                        value: Math.floor(rng() * 150000) + 50000  },
    { name: 'Support',                                value: Math.floor(rng() * 100000) + 20000  },
  ];

  // ── recent_items: 20 rows ─────────────────────────────────────────────────
  const itemNames = [
    'Acme Corp', 'Globex', 'Initech', 'Umbrella Ltd', 'Stark Industries',
    'Wayne Enterprises', 'Oscorp', 'Cyberdyne', 'Weyland-Yutani', 'Soylent Corp',
    'Massive Dynamic', 'Virtucon', 'Omni Consumer Products', 'Rekall', 'Tyrell Corp',
    'Buy N Large', 'Aperture Science', 'Black Mesa', 'Abstergo', 'Tessier-Ashpool',
  ];
  const catNames = categories.map((c) => c.name);
  const recentItems = itemNames.map((name, idx) => {
    const daysAgo = Math.floor(rng() * 30);
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    return {
      name,
      category: catNames[idx % catNames.length],
      value: Math.floor(rng() * 50000) + 1000,
      created_at: d.toISOString(),
    };
  });

  return { dailyMetrics, categories, recentItems };
}

export async function initDb() {
  const db = new PGlite(DB_PATH);

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id         SERIAL PRIMARY KEY,
      date       DATE        NOT NULL UNIQUE,
      visitors   INTEGER     NOT NULL,
      revenue    INTEGER     NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT    NOT NULL UNIQUE,
      value BIGINT  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT             NOT NULL,
      category   TEXT             NOT NULL,
      value      INTEGER          NOT NULL,
      created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed only if tables are empty
  const { rows: metricRows } = await db.query('SELECT COUNT(*) AS cnt FROM daily_metrics');
  const alreadySeeded = parseInt(metricRows[0].cnt, 10) > 0;

  if (!alreadySeeded) {
    console.log('Seeding database with deterministic data...');
    const { dailyMetrics, categories, recentItems } = generateSeedData();

    for (const row of dailyMetrics) {
      await db.query(
        'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
        [row.date, row.visitors, row.revenue],
      );
    }

    for (const row of categories) {
      await db.query(
        'INSERT INTO categories (name, value) VALUES ($1, $2)',
        [row.name, row.value],
      );
    }

    for (const row of recentItems) {
      await db.query(
        'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
        [row.name, row.category, row.value, row.created_at],
      );
    }

    // Default theme
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING",
    );

    console.log('Seed complete.');
  } else {
    // Ensure settings row exists even on subsequent boots
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING",
    );
    console.log('Database already seeded, skipping.');
  }

  return db;
}
