import {
  formatNumber,
  formatCurrency,
  formatDate,
  formatTrend,
} from '../utils/format.js';

/**
 * Render the four summary stat cards into #stat-grid.
 * @param {object} summary  – response from GET /api/summary
 */
export function renderStatCards(summary) {
  const grid = document.getElementById('stat-grid');
  if (!grid) return;

  const {
    totalVisitors,
    totalRevenue,
    bestDayDate,
    bestDayRevenue,
    trendPct,
  } = summary;

  const trendClass =
    trendPct > 0  ? 'stat-card__trend--up'
    : trendPct < 0 ? 'stat-card__trend--down'
    : 'stat-card__trend--neutral';

  const trendArrow = trendPct > 0 ? '▲' : trendPct < 0 ? '▼' : '●';

  const cards = [
    {
      label: 'Total Visitors',
      value: formatNumber(totalVisitors),
      sub:   'Last 30 days',
      trend: null,
    },
    {
      label: 'Total Revenue',
      value: formatCurrency(totalRevenue),
      sub:   'Last 30 days',
      trend: null,
    },
    {
      label: 'Best Day Revenue',
      value: formatCurrency(bestDayRevenue),
      sub:   formatDate(bestDayDate),
      trend: null,
    },
    {
      label: '7-Day Visitor Trend',
      value: formatTrend(trendPct),
      sub:   'vs previous 7 days',
      // Show a coloured badge for the trend direction
      trend: { pct: trendPct, cls: trendClass, arrow: trendArrow },
    },
  ];

  grid.innerHTML = cards.map(card => `
    <div class="stat-card" role="figure" aria-label="${card.label}: ${card.value}">
      <div class="stat-card__label">${card.label}</div>
      <div class="stat-card__value">${card.value}</div>
      <div class="stat-card__sub">${card.sub}</div>
      ${card.trend ? `
        <div class="stat-card__trend ${card.trend.cls}" aria-label="Trend: ${card.value}">
          <span aria-hidden="true">${card.trend.arrow}</span>
          <span>${formatTrend(card.trend.pct)}</span>
        </div>
      ` : ''}
    </div>
  `).join('');
}
