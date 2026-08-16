/**
 * Deterministic seed using a simple LCG (Linear Congruential Generator).
 * Fixed seed ensures identical data on every boot.
 */

function lcg(seed) {
  let state = seed;
  return function () {
    // LCG parameters from Numerical Recipes
    state = (1664525 * state + 1013904223) & 0xffffffff;
    // Return a value in [0, 1)
    return (state >>> 0) / 4294967296;
  };
}

export function generateSeedData() {
  const rand = lcg(42);

  // ── daily_metrics: 30 days ending yesterday ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dailyMetrics = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    // visitors: 800–4000
    const visitors = Math.floor(rand() * 3200) + 800;
    // revenue: 500–8000 (float, 2dp)
    const revenue = Math.round((rand() * 7500 + 500) * 100) / 100;

    dailyMetrics.push({ date: dateStr, visitors, revenue });
  }

  // ── categories: 6 rows ───────────────────────────────────────────────────
  // One long label, one value ≥ 1,000,000
  const categoryNames = [
    'Enterprise Infrastructure & Compliance', // long label
    'Cloud Services',
    'Mobile Apps',
    'Analytics',
    'Security',
    'Support',
  ];

  const categories = categoryNames.map((name, idx) => {
    let value;
    if (idx === 0) {
      // ≥ 1,000,000
      value = Math.floor(rand() * 500000) + 1000000;
    } else {
      value = Math.floor(rand() * 90000) + 10000;
    }
    return { name, value };
  });

  // ── recent_items: 20 rows ────────────────────────────────────────────────
  const itemNames = [
    'Alpha Project', 'Beta Initiative', 'Gamma Release', 'Delta Campaign',
    'Epsilon Study', 'Zeta Report', 'Eta Analysis', 'Theta Review',
    'Iota Survey', 'Kappa Audit', 'Lambda Sprint', 'Mu Deployment',
    'Nu Migration', 'Xi Integration', 'Omicron Patch', 'Pi Rollout',
    'Rho Upgrade', 'Sigma Refactor', 'Tau Hotfix', 'Upsilon Launch',
  ];

  const recentItems = itemNames.map((name, idx) => {
    const catIdx = Math.floor(rand() * categoryNames.length);
    const value = Math.round((rand() * 9000 + 100) * 100) / 100;
    // created_at: within last 30 days
    const daysAgo = Math.floor(rand() * 30);
    const createdAt = new Date(today);
    createdAt.setDate(createdAt.getDate() - daysAgo);
    return {
      name,
      category: categoryNames[catIdx],
      value,
      created_at: createdAt.toISOString(),
    };
  });

  return { dailyMetrics, categories, recentItems };
}
