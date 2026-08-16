/**
 * main.js — Dashboard entry point.
 *
 * Responsibilities:
 *  1. Load persisted theme from API and apply it before rendering.
 *  2. Fetch all API data in parallel.
 *  3. Render stat cards, chart, category breakdown, and recent-items table.
 *  4. Wire up the theme toggle.
 *  5. Show an explicit error state if the backend is unreachable.
 */

import { api }          from './api.js';
import { createChart }  from './chart.js';
import {
  fmtCurrency,
  fmtInt,
  fmtPct,
  fmtDate,
  fmtTimestamp,
  fmtStatNumber,
} from './formatters.js';

// ── Theme management ──────────────────────────────────────────────────────────
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try { sessionStorage.setItem('dashboard-theme', theme); } catch (_) {}
}

async function loadTheme() {
  try {
    const { theme } = await api.getSettings();
    applyTheme(theme);
  } catch (_) {
    // Backend unreachable — keep whatever the inline script set
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dashboard    = document.getElementById('dashboard');
const loadingState = document.getElementById('loading-state');
const themeToggle  = document.getElementById('theme-toggle');

// ── Theme toggle ──────────────────────────────────────────────────────────────
themeToggle.addEventListener('click', async () => {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Redraw chart with new theme colours
  if (chartInstance) {
    chartInstance.render(timeseriesData, activeMetric);
  }
  // Persist asynchronously — don't block the UI
  try { await api.putSettings(next); } catch (_) {}
});

// ── Chart state ───────────────────────────────────────────────────────────────
let chartInstance   = null;
let timeseriesData  = [];
let activeMetric    = 'visitors';

// ── Render helpers ────────────────────────────────────────────────────────────

function renderStatCards(summary) {
  const trend = summary.trend7d;
  const trendClass = trend === null ? 'neutral'
                   : trend > 0     ? 'positive'
                   :                 'negative';
  const trendArrow = trend === null ? '' : trend > 0 ? '▲' : '▼';

  const bestDayLabel = summary.bestDay
    ? `${fmtDate(summary.bestDay.date)} · ${fmtInt(summary.bestDay.visitors)} visitors`
    : '—';

  const cards = [
    {
      id:    'card-visitors',
      label: 'Total Visitors',
      value: fmtStatNumber(summary.totalVisitors),
      sub:   `<span class="stat-trend stat-trend--${trendClass}">
                <span class="stat-trend-arrow">${trendArrow}</span>
                ${fmtPct(trend)} vs prev 7 days
              </span>`,
    },
    {
      id:    'card-revenue',
      label: 'Total Revenue',
      value: fmtCurrency(summary.totalRevenue),
      sub:   '<span class="stat-label">30-day total</span>',
    },
    {
      id:    'card-bestday',
      label: 'Best Day',
      value: summary.bestDay ? fmtInt(summary.bestDay.visitors) : '—',
      sub:   `<span class="stat-label">${bestDayLabel}</span>`,
    },
    {
      id:    'card-bestrev',
      label: 'Best Day Revenue',
      value: summary.bestDay ? fmtCurrency(summary.bestDay.revenue) : '—',
      sub:   `<span class="stat-label">${summary.bestDay ? fmtDate(summary.bestDay.date) : ''}</span>`,
    },
  ];

  return `
    <section class="stat-cards" aria-label="Summary statistics">
      ${cards.map(c => `
        <article class="card stat-card" id="${c.id}">
          <div class="card-title">${c.label}</div>
          <div class="stat-value">${c.value}</div>
          ${c.sub}
        </article>
      `).join('')}
    </section>
  `;
}

function renderChartCard() {
  return `
    <article class="card chart-card" id="chart-card" aria-label="Time-series chart">
      <div class="section-title">30-Day Trend</div>
      <div class="chart-controls">
        <button class="chart-metric-btn active" data-metric="visitors">Visitors</button>
        <button class="chart-metric-btn" data-metric="revenue">Revenue</button>
      </div>
      <div class="chart-wrapper" id="chart-wrapper"></div>
    </article>
  `;
}

function renderCategories(categories) {
  if (!categories.length) return '<p class="stat-label">No data.</p>';

  const max = categories[0].value; // already sorted desc

  const items = categories.map(c => {
    const pct = max > 0 ? (c.value / max) * 100 : 0;
    return `
      <div class="category-item">
        <span class="category-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
        <div class="category-bar-track" role="progressbar"
             aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"
             aria-label="${escHtml(c.name)}: ${fmtInt(c.value)}">
          <div class="category-bar-fill" style="width: ${pct.toFixed(2)}%"></div>
        </div>
        <span class="category-value">${fmtInt(c.value)}</span>
      </div>
    `;
  }).join('');

  return `<div class="categories-list">${items}</div>`;
}

function renderCategoryCard(categories) {
  return `
    <article class="card" id="categories-card" aria-label="Category breakdown">
      <div class="section-title">Category Breakdown</div>
      ${renderCategories(categories)}
    </article>
  `;
}

function renderRecentTable(items) {
  if (!items.length) {
    return '<p class="stat-label">No recent items.</p>';
  }

  const rows = items.map(item => `
    <tr>
      <td class="col-name" title="${escHtml(item.name)}">${escHtml(item.name)}</td>
      <td class="col-category">
        <span class="badge" title="${escHtml(item.category)}">${escHtml(item.category)}</span>
      </td>
      <td class="col-value">${fmtCurrency(item.value)}</td>
      <td class="col-date">${fmtTimestamp(item.createdAt)}</td>
    </tr>
  `).join('');

  return `
    <div class="table-scroll">
      <table class="data-table" aria-label="Recent items">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Category</th>
            <th scope="col" style="text-align:right">Value</th>
            <th scope="col">Date</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderRecentCard(items) {
  return `
    <article class="card recent-section" id="recent-card" aria-label="Recent items">
      <div class="section-title">Recent Items</div>
      ${renderRecentTable(items)}
    </article>
  `;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Error state ───────────────────────────────────────────────────────────────
function showError(message) {
  dashboard.innerHTML = `
    <div class="error-state" role="alert" aria-live="assertive">
      <div class="error-icon">⚠️</div>
      <div class="error-title">Unable to load dashboard</div>
      <p class="error-message">${escHtml(message)}</p>
      <button class="error-retry-btn" id="retry-btn">Retry</button>
    </div>
  `;
  document.getElementById('retry-btn')?.addEventListener('click', () => {
    init();
  });
}

// ── Main init ─────────────────────────────────────────────────────────────────
async function init() {
  // Show loading
  dashboard.innerHTML = `
    <div class="loading-state" id="loading-state">
      <div class="spinner" aria-label="Loading…"></div>
      <p>Loading dashboard…</p>
    </div>
  `;

  // Destroy previous chart if re-initialising
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  try {
    // Load theme first (before rendering so colours are correct)
    await loadTheme();

    // Fetch all data in parallel
    const [summary, tsResult, catResult, recentResult] = await Promise.all([
      api.getSummary(),
      api.getTimeseries(),
      api.getCategories(),
      api.getRecent(),
    ]);

    timeseriesData = tsResult.data;
    const categories = catResult.data;
    const recentItems = recentResult.data;

    // ── Build dashboard HTML ──────────────────────────────────────────────────
    dashboard.innerHTML = `
      ${renderStatCards(summary)}
      <div class="body-grid">
        ${renderChartCard()}
        ${renderCategoryCard(categories)}
      </div>
      ${renderRecentCard(recentItems)}
    `;

    // ── Wire up chart ─────────────────────────────────────────────────────────
    const chartWrapper = document.getElementById('chart-wrapper');
    chartInstance = createChart(chartWrapper);
    chartInstance.render(timeseriesData, activeMetric);

    // Metric toggle buttons
    document.querySelectorAll('.chart-metric-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-metric-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeMetric = btn.dataset.metric;
        chartInstance.setMetric(activeMetric);
      });
    });

  } catch (err) {
    console.error('[dashboard] Load failed:', err);
    showError(
      'The backend server is not reachable. ' +
      'Please ensure the API server is running and try again.\n\n' +
      `(${err.message})`
    );
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
init();
