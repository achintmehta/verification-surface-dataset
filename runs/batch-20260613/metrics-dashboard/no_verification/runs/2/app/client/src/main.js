/**
 * Dashboard entry point.
 *
 * Responsibilities:
 *  1. Load persisted theme from the API and apply it before first paint.
 *  2. Fetch all dashboard data in parallel.
 *  3. Render stat cards, chart, category bars, and recent-items table.
 *  4. Wire up the theme toggle.
 *  5. Show an explicit error state if the backend is unreachable.
 */

import { api }        from './api.js';
import { initChart, redrawChart } from './chart.js';
import { fmtInt, fmtCurrency, fmtDate, fmtTrend } from './format.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const body          = document.body;
const themeToggle   = document.getElementById('theme-toggle');
const errorBanner   = document.getElementById('error-banner');
const errorMessage  = document.getElementById('error-message');
const loadingState  = document.getElementById('loading-state');
const dashboard     = document.getElementById('dashboard');

// Stat card elements
const statVisitors      = document.getElementById('stat-visitors');
const statTrend         = document.getElementById('stat-trend');
const statRevenue       = document.getElementById('stat-revenue');
const statBestdayV      = document.getElementById('stat-bestday-visitors');
const statBestdayDate   = document.getElementById('stat-bestday-date');
const statAvg           = document.getElementById('stat-avg');

// Chart
const chartCanvas       = document.getElementById('timeseries-chart');

// Categories
const categoriesList    = document.getElementById('categories-list');

// Table
const recentTbody       = document.getElementById('recent-tbody');

// ---------------------------------------------------------------------------
// Theme management
// ---------------------------------------------------------------------------
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  body.classList.toggle('theme-light', theme === 'light');
  body.classList.toggle('theme-dark',  theme === 'dark');
  // Redraw chart so it picks up new CSS colour vars
  redrawChart();
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await api.putSettings({ theme: next });
  } catch (err) {
    console.warn('Failed to persist theme:', err);
  }
}

themeToggle.addEventListener('click', toggleTheme);

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderStatCards(summary, timeseries) {
  // Total visitors
  statVisitors.textContent = fmtInt(summary.totalVisitors);

  // 7-day trend
  const { text, cls } = fmtTrend(summary.trendPct);
  statTrend.textContent = text;
  statTrend.className   = `stat-card-sub ${cls}`;

  // Total revenue
  statRevenue.textContent = fmtCurrency(summary.totalRevenue);

  // Best day
  if (summary.bestDay) {
    statBestdayV.textContent    = fmtInt(summary.bestDay.visitors) + ' visitors';
    statBestdayDate.textContent = fmtDate(summary.bestDay.date);
  }

  // Average daily visitors
  if (timeseries.length > 0) {
    const avg = summary.totalVisitors / timeseries.length;
    statAvg.textContent = fmtInt(avg);
  }
}

function renderCategories(categories) {
  if (!categories.length) {
    categoriesList.innerHTML = '<p style="color:var(--color-text-muted);font-size:.875rem">No data.</p>';
    return;
  }

  const maxVal = Math.max(...categories.map((c) => c.value));

  categoriesList.innerHTML = categories
    .map((cat) => {
      const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
      return `
        <div class="category-row">
          <div class="category-header">
            <span class="category-name" title="${escHtml(cat.name)}">${escHtml(cat.name)}</span>
            <span class="category-value">${fmtCurrency(cat.value)}</span>
          </div>
          <div class="category-bar-track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${escHtml(cat.name)}: ${fmtCurrency(cat.value)}">
            <div class="category-bar-fill" style="width:${pct.toFixed(2)}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderTable(items) {
  if (!items.length) {
    recentTbody.innerHTML = `
      <tr><td colspan="4" style="text-align:center;color:var(--color-text-muted);padding:2rem">No recent items.</td></tr>
    `;
    return;
  }

  recentTbody.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${escHtml(item.name)}</td>
        <td title="${escHtml(item.category)}">${escHtml(item.category)}</td>
        <td class="col-value">${fmtCurrency(item.value)}</td>
        <td class="col-date">${fmtDate(item.createdAt)}</td>
      </tr>
    `
    )
    .join('');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------
function showError(msg) {
  loadingState.hidden = true;
  dashboard.hidden    = true;
  errorBanner.hidden  = false;
  errorMessage.textContent = msg;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function bootstrap() {
  // 1. Load theme first (before showing content) to avoid flash
  try {
    const settings = await api.getSettings();
    applyTheme(settings.theme);
  } catch {
    // Backend unreachable — apply default theme and show error
    applyTheme('light');
    showError(
      'Unable to reach the backend server. Please ensure the server is running on port 3001.'
    );
    return;
  }

  // 2. Fetch all dashboard data in parallel
  let summary, timeseries, categories, recent;
  try {
    [summary, timeseries, categories, recent] = await Promise.all([
      api.getSummary(),
      api.getTimeseries(),
      api.getCategories(),
      api.getRecent(),
    ]);
  } catch (err) {
    showError(
      `Failed to load dashboard data: ${err.message}. Please check the server.`
    );
    return;
  }

  // 3. Render
  loadingState.hidden = true;
  dashboard.hidden    = false;

  renderStatCards(summary, timeseries);
  renderCategories(categories);
  renderTable(recent);

  // Chart is initialized after the dashboard is visible so the container
  // has non-zero dimensions.
  requestAnimationFrame(() => {
    initChart(chartCanvas, timeseries);
  });
}

bootstrap();
