/**
 * Renders the four summary stat cards.
 */

function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function formatCurrency(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  // dateStr may be a Date object or ISO string
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function trendIcon(pct) {
  if (pct > 0) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15"/>
    </svg>`;
  } else if (pct < 0) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>`;
}

function trendClass(pct) {
  if (pct > 0) return 'trend--up';
  if (pct < 0) return 'trend--down';
  return 'trend--neutral';
}

const CARD_ICONS = {
  visitors: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>`,
  revenue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="1" x2="12" y2="23"/>
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
  </svg>`,
  bestDay: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>`,
  trend: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
    <polyline points="16 7 22 7 22 13"/>
  </svg>`,
};

export function renderStatCards(summary) {
  const container = document.getElementById('stat-cards');
  if (!container || !summary) return;

  const { totalVisitors, totalRevenue, bestDay, trendPct } = summary;

  const cards = [
    {
      id: 'card-visitors',
      icon: CARD_ICONS.visitors,
      label: 'Total Visitors',
      value: formatNumber(totalVisitors),
      trend: null,
      sub: 'Last 30 days',
    },
    {
      id: 'card-revenue',
      icon: CARD_ICONS.revenue,
      label: 'Total Revenue',
      value: formatCurrency(totalRevenue),
      trend: null,
      sub: 'Last 30 days',
    },
    {
      id: 'card-bestday',
      icon: CARD_ICONS.bestDay,
      label: 'Best Day Revenue',
      value: bestDay ? formatCurrency(bestDay.revenue) : '—',
      trend: null,
      sub: bestDay ? formatDate(bestDay.date) : '',
    },
    {
      id: 'card-trend',
      icon: CARD_ICONS.trend,
      label: '7-Day Trend',
      value: `${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(1)}%`,
      trend: trendPct,
      sub: 'vs. prior 7 days',
    },
  ];

  container.innerHTML = cards.map(card => `
    <div class="stat-card" id="${card.id}">
      <div class="stat-card__icon">${card.icon}</div>
      <div class="stat-card__label">${card.label}</div>
      <div class="stat-card__value">${card.value}</div>
      ${card.trend !== null
        ? `<div class="stat-card__trend ${trendClass(card.trend)}">
            ${trendIcon(card.trend)}
            <span>${Math.abs(card.trend).toFixed(1)}% vs prior week</span>
          </div>`
        : `<div class="stat-card__sub">${card.sub}</div>`
      }
    </div>
  `).join('');
}
