/**
 * Deterministic seed for the metrics dashboard.
 * Uses a simple seeded PRNG so every fresh boot produces identical data.
 */

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(db) {
  // Check if already seeded by trying to query the table
  try {
    const count = await db.query('SELECT count(*)::int AS c FROM daily_metrics');
    if (count.rows[0].c > 0) {
      console.log('[seed] Database already seeded, skipping.');
      return;
    }
  } catch (e) {
    // Table doesn't exist yet, proceed with seeding
  }

  console.log('[seed] Creating schema and seeding data...');

  // --- Schema ---
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      visitors INT NOT NULL,
      revenue NUMERIC(12,2) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value INT NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recent_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      value NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const rand = mulberry32(42);

  // Helper: random int in [min, max]
  const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  // Helper: random float in [min, max] rounded to 2 decimals
  const randFloat = (min, max) => +(min + rand() * (max - min)).toFixed(2);

  // --- daily_metrics: 30 rows ---
  const today = new Date('2025-01-30');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = randInt(800, 5000);
    const revenue = randFloat(1500, 12000);
    await db.query(
      'INSERT INTO daily_metrics (date, visitors, revenue) VALUES ($1, $2, $3)',
      [dateStr, visitors, revenue]
    );
  }

  // --- categories: 6 rows (one long label, one value >= 1,000,000) ---
  const categoryData = [
    ['SaaS Products', randInt(200000, 400000)],
    ['Enterprise Infrastructure & Compliance', 1345678],            // long name + 7-digit value
    ['Mobile Apps', randInt(100000, 250000)],
    ['Consulting', randInt(50000, 150000)],
    ['Cloud Services', randInt(300000, 600000)],
    ['Support & Maintenance', randInt(80000, 200000)],
  ];
  for (const [name, value] of categoryData) {
    await db.query('INSERT INTO categories (name, value) VALUES ($1, $2)', [name, value]);
  }

  // --- recent_items: 20 rows ---
  const itemNames = [
    'Alpha Release', 'Beta Deployment', 'Gamma Patch', 'Delta Module',
    'Epsilon Widget', 'Zeta Service', 'Eta Integration', 'Theta Update',
    'Iota Connector', 'Kappa Plugin', 'Lambda Tool', 'Mu Framework',
    'Nu Extension', 'Xi Package', 'Omicron Lib', 'Pi Dashboard',
    'Rho Analytics', 'Sigma Report', 'Tau Scheduler', 'Upsilon Monitor',
  ];
  const itemCategories = ['SaaS Products', 'Mobile Apps', 'Cloud Services',
    'Consulting', 'Enterprise Infrastructure & Compliance', 'Support & Maintenance'];

  for (let i = 0; i < 20; i++) {
    const name = itemNames[i];
    const category = itemCategories[i % itemCategories.length];
    const value = randFloat(100, 50000);
    const ts = new Date(today);
    ts.setDate(ts.getDate() - i);
    ts.setHours(randInt(8, 20), randInt(0, 59), randInt(0, 59));
    await db.query(
      'INSERT INTO recent_items (name, category, value, created_at) VALUES ($1, $2, $3, $4)',
      [name, category, value, ts.toISOString()]
    );
  }

  // --- settings ---
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING`
  );

  console.log('[seed] Done.');
}
