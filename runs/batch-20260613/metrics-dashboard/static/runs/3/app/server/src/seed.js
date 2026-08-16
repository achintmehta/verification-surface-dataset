/**
 * Deterministic seed using a simple LCG (linear congruential generator).
 * All values are derived from a fixed seed so any two correct implementations
 * produce identical data.
 */

function makeLCG(seed) {
  let s = seed >>> 0;
  return function next(min, max) {
    // LCG parameters from Numerical Recipes
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    const frac = s / 0x100000000;
    return Math.floor(frac * (max - min + 1)) + min;
  };
}

export async function seedDatabase(db) {
  // Check if already seeded
  const check = await db.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'settings'`
  );
  if (parseInt(check.rows[0].cnt, 10) > 0) {
    // Tables exist — check if data is present
    const dataCheck = await db.query(`SELECT COUNT(*) AS cnt FROM daily_metrics`);
    if (parseInt(dataCheck.rows[0].cnt, 10) > 0) {
      console.log('[seed] Database already seeded, skipping.');
      return;
    }
  }

  console.log('[seed] Creating schema and seeding data…');

  // ── Schema ────────────────────────────────────────────────────────────────
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id         SERIAL PRIMARY KEY,
      date       DATE        NOT NULL UNIQUE,
      visitors   INTEGER     NOT NULL,
      revenue    NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL UNIQUE,
      value      BIGINT      NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_items (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL,
      category   TEXT        NOT NULL,
      value      NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL
    );
  `);

  const rng = makeLCG(0xdeadbeef);

  // ── daily_metrics: 30 days ending yesterday ───────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = rng(800, 5000);
    const revenue = (rng(500, 4000) + rng(0, 99) / 100).toFixed(2);
    await db.query(
      `INSERT INTO daily_metrics (date, visitors, revenue)
       VALUES ($1, $2, $3)
       ON CONFLICT (date) DO NOTHING`,
      [dateStr, visitors, revenue]
    );
  }

  // ── categories: 6 rows, one long label, one value ≥ 1,000,000 ────────────
  const categoryData = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_284_750 },
    { name: 'Cloud Services',                         value: rng(200_000, 800_000) },
    { name: 'Professional Services',                  value: rng(100_000, 400_000) },
    { name: 'Support & Maintenance',                  value: rng(50_000,  200_000) },
    { name: 'Training & Certification',               value: rng(20_000,  100_000) },
    { name: 'Consulting',                             value: rng(10_000,   80_000) },
  ];

  for (const cat of categoryData) {
    await db.query(
      `INSERT INTO categories (name, value)
       VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      [cat.name, cat.value]
    );
  }

  // ── recent_items: 20 rows ─────────────────────────────────────────────────
  const itemNames = [
    'Acme Corp Renewal', 'Beta Systems Upgrade', 'Gamma Analytics Suite',
    'Delta Cloud Migration', 'Epsilon Security Audit', 'Zeta Data Pipeline',
    'Eta Monitoring Setup', 'Theta Compliance Review', 'Iota API Integration',
    'Kappa Dashboard Build', 'Lambda Storage Expansion', 'Mu Network Overhaul',
    'Nu Backup Solution', 'Xi Reporting Module', 'Omicron Auth Service',
    'Pi Load Balancer', 'Rho Cache Layer', 'Sigma Search Index',
    'Tau Notification Hub', 'Upsilon Billing Engine',
  ];

  const catNames = categoryData.map((c) => c.name);
  const baseTime = new Date(today);
  baseTime.setDate(baseTime.getDate() - 20);

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = catNames[rng(0, catNames.length - 1)];
    const value = (rng(1000, 50000) + rng(0, 99) / 100).toFixed(2);
    const createdAt = new Date(baseTime);
    createdAt.setDate(createdAt.getDate() + i);
    createdAt.setHours(rng(8, 18), rng(0, 59), rng(0, 59));
    await db.query(
      `INSERT INTO recent_items (name, category, value, created_at)
       VALUES ($1, $2, $3, $4)`,
      [name, category, value, createdAt.toISOString()]
    );
  }

  // ── settings: default theme ───────────────────────────────────────────────
  await db.query(
    `INSERT INTO settings (key, value)
     VALUES ('theme', 'light')
     ON CONFLICT (key) DO NOTHING`
  );

  console.log('[seed] Done.');
}
