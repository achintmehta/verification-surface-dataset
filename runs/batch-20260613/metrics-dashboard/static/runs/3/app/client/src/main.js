/**
 * Dashboard entry point.
 *
 * Responsibilities:
 *  1. Fetch persisted theme from server and apply it before rendering.
 *  2. Fetch all dashboard data in parallel.
 *  3. Render stat cards, time-series chart, category bars, and recent table.
 *  4. Wire up the theme toggle.
 *  5. Show explicit error state when the backend is unreachable.
 */

import { fetchSummary, fetchTimeseries, fetchCategories, fetchRecent,
         fetchSettings, putSettings } from './api.js';
import { TimeSeriesChart } from './chart.js';
import {
  formatCurrency, formatCurrencyFull, formatNumber,
  formatCompact, formatDate, formatDateTime, formatTrend,
} from './utils/format.js';

// ── DOM refs ────────────────────────────────────────────────────────────────
const loadingEl  = document.getElementById('loading-state');
const errorEl    = document.getElementById('error-state');
const errorMsgEl = document.getElementById('error-message');
const retryBtn   = document.getElementById('retry-btn');
const dashEl     = document.getElementById('dashboard');
const statGrid   = document.getElementById('stat-grid');
const catList    = document.getElementById('categories-list');
const recentTbody = document.getElementById('recent-tbody');
const themeToggle = document.getElementById('theme-toggle');
const canvas     = document.getElementById('timeseries-canvas');
const chartContainer = document.getElementById('timeseries-container');

// ── Chart instance ──────────────────────────────────────────────────────────
const chart = new TimeSeriesChart(canvas, chartContainer);

// ── Theme management ────────────────────────────────────────────────────────
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  sessionStorage.setItem('theme', theme);
  // Redraw chart so it picks up new CSS var colours
  chart.redraw();
}

async function loadTheme() {
  try {
    const { theme } = await fetchSettings();
    applyTheme(theme);
  } catch {
    // If settings fail, keep whatever was applied from sessionStorage cache
    // (already set in the inline script in index.html)
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await putSettings({ theme: next });
  } catch (err) {
    console.warn('[theme] Failed to persist theme:', err);
  }
}

themeToggle.addEventListener('click', toggleTheme);

// ── Stat cards ──────────────────────────────────────────────────────────────
function renderStatCards(summary) {
  const trendClass =
    summary.trend_pct > 0 ? 'up' :
    summary.trend_pct < 0 ? 'down' : 'neutral';

  const trendArrow =
    summary.trend_pct > 0 ? '▲' :
    summary.trend_pct < 0 ? '▼' : '—';

  const cards = [
    {
      label: 'Total Visitors',
      value: formatNumber(summary.total_visitors),
      meta: `<span class="stat-card__sub">All time</span>`,
      icon: '👥',
    },
    {
      label: 'Total Revenue',
      value: formatCurrency(summary.total_revenue),
      meta: `<span class="stat-card__sub">30-day period</span>`,
      icon: '💰',
    },
    {
      label: 'Best Day Revenue',
      value: formatCurrency(summary.best_day.revenue),
      meta: `<span class="stat-card__sub">${formatDate(summary.best_day.date)}</span>`,
      icon: '🏆',
    },
    {
      label: '7-Day Trend',
      value: formatTrend(summary.trend_pct),
      meta: `<span class="stat-card__trend stat-card__trend--${trendClass}">
               <span class="stat-card__trend-arrow">${trendArrow}</span>
               vs prior 7 days
             </span>`,
      icon: '📈',
    },
  ];

  statGrid.innerHTML = cards.map((c) => `
    <div class="card stat-card" role="region" aria-label="${escHtml(c.label)}">
      <div class="stat-card__label">${escHtml(c.label)}</div>
      <div class="stat-card__value">${escHtml(c.value)}</div>
      <div class="stat-card__meta">${c.meta}</div>
    </div>
  `).join('');
}

// ── Category bars ────────────────────────────────────────────────────────────
function renderCategories(categories) {
  if (!categories.length) {
    catList.innerHTML = '<p class="empty">No categories found.</p>';
    return;
  }

  const maxVal = Math.max(...categories.map((c) => c.value));

  catList.innerHTML = categories.map((cat) => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    return `
      <div class="category-row">
        <span class="category-row__label" title="${escHtml(cat.name)}">${escHtml(cat.name)}</span>
        <div class="category-row__bar-track" role="presentation">
          <div
            class="category-row__bar-fill"
            style="width: ${pct.toFixed(1)}%"
            role="progressbar"
            aria-valuenow="${cat.value}"
            aria-valuemin="0"
            aria-valuemax="${maxVal}"
            aria-label="${escHtml(cat.name)}: ${formatCompact(cat.value)}"
          ></div>
        </div>
        <span class="category-row__value">${formatCompact(cat.value)}</span>
      </div>
    `;
  }).join('');
}

// ── Recent items table ───────────────────────────────────────────────────────
function renderRecentTable(items) {
  if (!items.length) {
    recentTbody.innerHTML = `
      <tr><td colspan="4" style="text-align:center;color:var(--color-text-muted)">No items found.</td></tr>
    `;
    return;
  }

  recentTbody.innerHTML = items.map((item) => `
    <tr>
      <td title="${escHtml(item.name)}">${escHtml(item.name)}</td>
      <td title="${escHtml(item.category)}">${escHtml(item.category)}</td>
      <td class="text-right">${formatCurrencyFull(item.value)}</td>
      <td>${formatDateTime(item.created_at)}</td>
    </tr>
  `).join('');
}

// ── Main load ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  // Show loading, hide others
  loadingEl.hidden  = false;
  errorEl.hidden    = true;
  dashEl.hidden     = true;

  try {
    // Load theme first so it's applied before we render
    await loadTheme();

    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent(),
    ]);

    // Render
    renderStatCards(summary);
    renderCategories(categories);
    renderRecentTable(recent);

    // Mount chart (starts ResizeObserver) then set data
    chart.mount();
    chart.setData(timeseries);

    // Show dashboard
    loadingEl.hidden = true;
    dashEl.hidden    = false;
  } catch (err) {
    console.error('[dashboard] Load failed:', err);
    loadingEl.hidden = true;
    dashEl.hidden    = true;
    errorEl.hidden   = false;
    errorMsgEl.textContent =
      'Could not connect to the backend server. ' +
      'Please ensure the server is running and try again.';
  }
}

retryBtn.addEventListener('click', loadDashboard);

// ── Bootstrap ────────────────────────────────────────────────────────────────
loadDashboard();

// ── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
