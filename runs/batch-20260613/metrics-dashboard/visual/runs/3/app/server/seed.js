// Deterministic seed using a simple LCG PRNG
function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function getSeedData() {
  const rng = makePrng(42);

  // 30 days of daily metrics ending today (deterministic relative to a fixed epoch)
  const baseDate = new Date('2024-01-01');
  const dailyMetrics = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const visitors = Math.floor(rng() * 4000) + 500;   // 500–4500
    const revenue = Math.floor(rng() * 15000) + 1000;  // 1000–16000
    dailyMetrics.push({ date: dateStr, visitors, revenue });
  }

  // 6 categories — one long label, one value ≥ 1,000,000
  const categories = [
    { name: 'Enterprise Infrastructure & Compliance', value: 1_250_000 },
    { name: 'Cloud Services', value: Math.floor(rng() * 500000) + 300000 },
    { name: 'Professional Services', value: Math.floor(rng() * 300000) + 150000 },
    { name: 'Support & Maintenance', value: Math.floor(rng() * 200000) + 80000 },
    { name: 'Training', value: Math.floor(rng() * 100000) + 20000 },
    { name: 'Licensing', value: Math.floor(rng() * 80000) + 10000 },
  ];

  // 20 recent items
  const itemNames = [
    'Alpha Project', 'Beta Initiative', 'Gamma Campaign', 'Delta Program',
    'Epsilon Task', 'Zeta Workflow', 'Eta Module', 'Theta Pipeline',
    'Iota Service', 'Kappa Platform', 'Lambda Function', 'Mu Integration',
    'Nu Dashboard', 'Xi Analytics', 'Omicron Report', 'Pi Automation',
    'Rho Connector', 'Sigma Gateway', 'Tau Processor', 'Upsilon Engine',
  ];
  const catNames = categories.map(c => c.name);
  const recentItems = itemNames.map((name, i) => {
    const createdAt = new Date(baseDate);
    createdAt.setDate(baseDate.getDate() + Math.floor(rng() * 30));
    return {
      name,
      category: catNames[i % catNames.length],
      value: Math.floor(rng() * 50000) + 500,
      created_at: createdAt.toISOString(),
    };
  });

  return { dailyMetrics, categories, recentItems };
}
