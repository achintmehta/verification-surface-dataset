/**
 * Metrics Dashboard – main entry point
 *
 * Orchestrates:
 *  1. Theme initialisation (fetched from server, cached in sessionStorage)
 *  2. Parallel data fetch from all API endpoints
 *  3. Rendering stat cards, chart, breakdown, table
 *  4. Chart resize observer (redraws on container size change)
 *  5. Theme toggle (persists to server)
 */

import { renderChart } from './chart.js';
import { formatNumber, formatCurrency, formatDate, formatPercent } from './format.js';

const API_BASE = '/api';

/* ================================================================== */
/*  DOM refs                                                            */
/* ================================================================== */
const body           = document.body;
const themeToggle    = document.getElementById('theme-toggle');
const errorBanner    = document.getElementById('error-banner');
const loadingState   = document.getElementById('loading-state');
const dashboard      = document.getElementById('dashboard');

// Stat card elements
const elVisitors     = document.getElementById('stat-visitors');
const elVisitorsSub  = document.getElementById('stat-visitors-sub');
const elRevenue      = document.getElementById('stat-revenue');
const elRevenueSub   = document.getElementById('stat-revenue-sub');
const elBestDay      = document.getElementById('stat-bestday');
const elBestDaySub   = document.getElementById('stat-bestday-sub');
const elTrend        = document.getElementById('stat-trend');
const elTrendSub     = document.getElementById('stat-trend-sub');

// Chart
const chartContainer = document.getElementById('chart-container');
const chartSvg       = document.getElementById('timeseries-chart');

// Breakdown
const breakdownList  = document.getElementById('breakdown-list');

// Table
const recentTbody    = document.getElementById('recent-tbody');

/* ================================================================== */
/*  Theme management                                                    */
/* ================================================================== */
let currentTheme = 'light';

/**
 * Apply a theme by toggling CSS classes on <body>.
 * Also caches the value in sessionStorage for fast-path on next load.
 */
function applyTheme(theme) {
  currentTheme = theme;
  body.classList.toggle('theme-light', theme === 'light');
  body.classList.toggle('theme-dark',  theme === 'dark');
  try { sessionStorage.setItem('dashboard-theme', theme); } catch (_) {}
}

/**
 * Fetch the persisted theme from the server and apply it.
 * Falls back to 'light' if the server is unreachable.
 */
async function loadTheme() {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error('settings fetch failed');
    const { theme } = await res.json();
    applyTheme(theme);
  } catch {
    applyTheme('light');
  }
}

/**
 * Toggle between light and dark, redraw the chart, and persist to server.
 */
async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);

  // Redraw chart so it picks up new CSS colour variables
  if (window.__chartData) {
    renderChart(chartSvg, chartContainer, window.__chartData);
  }

  // Persist to server (fire-and-forget; failure is non-fatal)
  try {
    await fetch(`${API_BASE}/settings`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ theme: next }),
    });
  } catch (err) {
    console.warn('[theme] Failed to persist theme preference:', err);
  }
}

themeToggle.addEventListener('click', toggleTheme);

/* ================================================================== */
/*  Data fetching                                                       */
/* ================================================================== */

/**
 * Fetch all four API endpoints in parallel.
 * Throws if any request fails (triggers error state in boot()).
 */
async function fetchAll() {
  const [summary, timeseries, categories, recent] = await Promise.all([
    fetch(`${API_BASE}/summary`)
      .then(r => { if (!r.ok) throw new Error(`summary ${r.status}`); return r.json(); }),
    fetch(`${API_BASE}/timeseries`)
      .then(r => { if (!r.ok) throw new Error(`timeseries ${r.status}`); return r.json(); }),
    fetch(`${API_BASE}/categories`)
      .then(r => { if (!r.ok) throw new Error(`categories ${r.status}`); return r.json(); }),
    fetch(`${API_BASE}/recent`)
      .then(r => { if (!r.ok) throw new Error(`recent ${r.status}`); return r.json(); }),
  ]);
  return { summary, timeseries, categories, recent };
}

/* ================================================================== */
/*  Render: stat cards                                                  */
/* ================================================================== */
function renderStatCards(summary) {
  // Total visitors
  elVisitors.textContent    = formatNumber(summary.totalVisitors);
  elVisitorsSub.textContent = 'all time';

  // Total revenue
  elRevenue.textContent    = formatCurrency(summary.totalRevenue);
  elRevenueSub.textContent = 'all time';

  // Best day
  elBestDay.textContent    = formatNumber(summary.bestDay.visitors);
  elBestDaySub.textContent = formatDate(summary.bestDay.date);

  // 7-day trend — formatPercent includes the sign; prepend '+' for positive
  const trend = summary.trend7d;
  const trendStr = trend >= 0
    ? `+${formatPercent(trend)}`
    : formatPercent(trend);   // formatPercent includes '-' for negatives
  elTrend.textContent    = trendStr;
  elTrendSub.textContent = 'vs prior 7 days';

  // Colour the trend value
  const trendClass = trend >= 0 ? 'stat-card__sub--positive' : 'stat-card__sub--negative';
  elTrend.className = `stat-card__value ${trendClass}`;
}

/* ================================================================== */
/*  Render: category breakdown                                          */
/* ================================================================== */
function renderBreakdown(categories) {
  breakdownList.innerHTML = '';

  if (!categories || categories.length === 0) {
    breakdownList.innerHTML =
      '<p style="color:var(--color-text-muted);font-size:.875rem">No category data</p>';
    return;
  }

  const maxVal = Math.max(...categories.map(c => Number(c.value)), 1);

  categories.forEach(cat => {
    const pct = (Number(cat.value) / maxVal) * 100;

    const item = document.createElement('div');
    item.className = 'breakdown-item';

    // Use innerHTML for conciseness; values are escaped
    item.innerHTML = `
      <div class="breakdown-item__header">
        <span class="breakdown-item__name" title="${esc(cat.name)}">${esc(cat.name)}</span>
        <span class="breakdown-item__value">${formatNumber(cat.value)}</span>
      </div>
      <div class="breakdown-item__bar-track"
           role="progressbar"
           aria-valuenow="${Math.round(pct)}"
           aria-valuemin="0"
           aria-valuemax="100"
           aria-label="${esc(cat.name)}: ${formatNumber(cat.value)}">
        <div class="breakdown-item__bar-fill" style="width:${pct.toFixed(2)}%"></div>
      </div>
    `;
    breakdownList.appendChild(item);
  });
}

/* ================================================================== */
/*  Render: recent items table                                          */
/* ================================================================== */
function renderTable(recent) {
  recentTbody.innerHTML = '';

  if (!recent || recent.length === 0) {
    recentTbody.innerHTML =
      `<tr><td colspan="4" style="text-align:center;padding:1.5rem;color:var(--color-text-muted)">No recent items</td></tr>`;
    return;
  }

  recent.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(item.name)}</td>
      <td title="${esc(item.category)}">${esc(item.category)}</td>
      <td class="num-col">${formatCurrency(item.value)}</td>
      <td class="date-col">${formatDate(item.created_at)}</td>
    `;
    recentTbody.appendChild(tr);
  });
}

/* ================================================================== */
/*  Utility: HTML escape                                                */
/* ================================================================== */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ================================================================== */
/*  Chart resize observer                                               */
/* ================================================================== */
let resizeObserver = null;

function setupChartResize(data) {
  if (resizeObserver) resizeObserver.disconnect();

  resizeObserver = new ResizeObserver(_entries => {
    // Redraw on every container size change
    renderChart(chartSvg, chartContainer, data);
  });

  resizeObserver.observe(chartContainer);
}

/* ================================================================== */
/*  Boot sequence                                                       */
/* ================================================================== */
async function boot() {
  // 1. Apply persisted theme before showing any content
  await loadTheme();

  try {
    // 2. Fetch all data in parallel
    const { summary, timeseries, categories, recent } = await fetchAll();

    // 3. Render each section
    renderStatCards(summary);
    renderBreakdown(categories);
    renderTable(recent);

    // 4. Store chart data for theme-toggle redraws
    window.__chartData = timeseries;

    // 5. Initial chart draw
    renderChart(chartSvg, chartContainer, timeseries);

    // 6. Set up resize observer for responsive chart redraws
    setupChartResize(timeseries);

    // 7. Reveal dashboard, hide loading spinner
    loadingState.hidden = true;
    dashboard.hidden    = false;

  } catch (err) {
    console.error('[boot] Failed to load dashboard data:', err);
    loadingState.hidden = true;
    errorBanner.hidden  = false;
  }
}

boot();
