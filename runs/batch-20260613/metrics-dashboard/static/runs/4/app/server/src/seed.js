/**
 * Deterministic seed using a simple LCG (linear congruential generator).
 * All values are derived from a fixed seed so any two correct implementations
 * produce identical data.
 */

// LCG parameters (Numerical Recipes)
const LCG_A = 1664525;
const LCG_B = 1013904223;
const LCG_M = 2 ** 32;

function makeLcg(seed) {
  let state = seed >>> 0;
  return function next(min, max) {
    state = ((LCG_A * state + LCG_B) >>> 0) % LCG_M;
    // normalise to [0,1)
    const r = state / LCG_M;
    return Math.floor(r * (max - min + 1)) + min;
  };
}

export async function seedDatabase(db) {
  // ── Create schema ──────────────────────────────────────────────────────────
  await db.exec(`
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
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ── Guard: skip if already seeded ─────────────────────────────────────────
  const { rows: existing } = await db.query(
    `SELECT COUNT(*) AS cnt FROM daily_metrics`
  );
  if (Number(existing[0].cnt) > 0) {
    console.log('[seed] database already seeded – skipping');
    return;
  }

  console.log('[seed] seeding database …');

  const rand = makeLcg(0xdeadbeef);

  // ── daily_metrics: 30 days ending yesterday ────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = rand(800, 5000);
    const revenue = (rand(500, 4000) + rand(0, 99) / 100).toFixed(2);
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)`,
      [dateStr, visitors, revenue]
    );
  }

  // ── categories: 6 rows, one long label, one value ≥ 1 000 000 ─────────────
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_750.0 },
    { name: 'Cloud Services',                         value: rand(50000, 300000) },
    { name: 'Professional Services',                  value: rand(30000, 150000) },
    { name: 'Support & Maintenance',                  value: rand(20000, 80000) },
    { name: 'Training & Certification',               value: rand(10000, 50000) },
    { name: 'Marketplace Add-ons',                    value: rand(5000, 30000) },
  ];

  for (const cat of categories) {
    await db.query(
      `INSERT INTO categories (name, value) VALUES ($1, $2)`,
      [cat.name, cat.value.toFixed(2)]
    );
  }

  // ── recent_items: 20 rows ──────────────────────────────────────────────────
  const itemNames = [
    'Acme Corp Renewal',       'Beta Systems Upgrade',    'Gamma Analytics Pro',
    'Delta Compliance Suite',  'Epsilon Cloud Bundle',    'Zeta Support Pack',
    'Eta Training Voucher',    'Theta Marketplace Plugin','Iota Infrastructure Kit',
    'Kappa Security Audit',    'Lambda DevOps Toolchain', 'Mu Data Pipeline',
    'Nu Reporting Module',     'Xi Integration Bridge',   'Omicron API Gateway',
    'Pi Monitoring Agent',     'Rho Backup Service',      'Sigma CDN Package',
    'Tau Identity Provider',   'Upsilon Load Balancer',
  ];

  const catNames = categories.map(c => c.name);

  const baseTime = new Date(today);
  baseTime.setDate(baseTime.getDate() - 20);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[rand(0, catNames.length - 1)];
    const value = (rand(100, 50000) + rand(0, 99) / 100).toFixed(2);
    const createdAt = new Date(baseTime);
    createdAt.setDate(createdAt.getDate() + i);
    createdAt.setHours(rand(8, 18), rand(0, 59), rand(0, 59));
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  // ── settings: default theme ────────────────────────────────────────────────
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`
  );

  console.log('[seed] done');
}
