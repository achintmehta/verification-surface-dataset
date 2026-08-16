/**
 * Populates the four summary stat cards from API data.
 */

import { formatNumber, formatCurrency, formatTrend, formatDate } from './utils/format.js';

/**
 * @param {object} summary  Response from GET /api/summary
 */
export function renderCards(summary) {
  const {
    total_visitors,
    total_revenue,
    best_day,
    trend_7d_pct,
  } = summary;

  // ── Total Visitors ────────────────────────────────────────────────────────
  setText('stat-visitors', formatNumber(total_visitors));
  setText('stat-visitors-sub', 'Across all 30 days');

  // ── Total Revenue ─────────────────────────────────────────────────────────
  setText('stat-revenue', formatCurrency(total_revenue));
  setText('stat-revenue-sub', 'Across all 30 days');

  // ── Best Day ──────────────────────────────────────────────────────────────
  setText('stat-best-day', formatCurrency(best_day.revenue));
  const bestDateEl = document.getElementById('stat-best-day-sub');
  if (bestDateEl) {
    bestDateEl.textContent = formatDate(best_day.date, true);
  }

  // ── 7-Day Trend ───────────────────────────────────────────────────────────
  const trendEl    = document.getElementById('stat-trend');
  const trendSubEl = document.getElementById('stat-trend-sub');

  if (trendEl) {
    trendEl.textContent = formatTrend(trend_7d_pct);
    trendEl.className = 'card__value';
    if (trend_7d_pct > 0) {
      trendEl.style.color = 'var(--color-trend-up)';
    } else if (trend_7d_pct < 0) {
      trendEl.style.color = 'var(--color-trend-down)';
    } else {
      trendEl.style.color = '';
    }
  }

  if (trendSubEl) {
    const arrow = trend_7d_pct >= 0 ? '↑' : '↓';
    trendSubEl.textContent = `${arrow} vs previous 7 days`;
    trendSubEl.className = `card__sub ${trend_7d_pct >= 0 ? 'card__sub--up' : 'card__sub--down'}`;
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
