import { api } from './api.js';
import { TimeSeriesChart } from './chart.js';
import {
  formatCurrency,
  formatNumber,
  formatDate,
  formatDateTime,
  formatTrend,
} from './formatters.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $themeToggle    = document.getElementById('theme-toggle');
const $errorBanner    = document.getElementById('error-banner');
const $dashboard      = document.getElementById('dashboard');

// Stat card values
const $valVisitors    = document.getElementById('val-visitors');
const $trendVisitors  = document.getElementById('trend-visitors');
const $valRevenue     = document.getElementById('val-revenue');
const $valBestDay     = document.getElementById('val-best-day');
const $subBestDay     = document.getElementById('sub-best-day');
const $valTrend       = document.getElementById('val-trend');

// Stat card containers (for skeleton removal)
const $cardVisitors   = document.getElementById('card-visitors');
const $cardRevenue    = document.getElementById('card-revenue');
const $cardBestDay    = document.getElementById('card-best-day');
const $cardTrend      = document.getElementById('card-trend');

// Chart
const $chartContainer = document.getElementById('chart-container');
const $canvas         = document.getElementById('timeseries-chart');

// Categories
const $categoriesList = document.getElementById('categories-list');

// Table
const $recentTbody    = document.getElementById('recent-tbody');

// ---------------------------------------------------------------------------
// Chart instance
// ---------------------------------------------------------------------------
let chart = null;

// ---------------------------------------------------------------------------
// Theme management
// ---------------------------------------------------------------------------
function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (chart) chart.onThemeChange();
}

async function toggleTheme() {
  const next = getCurrentTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await api.putSettings({ theme: next });
  } catch (err) {
    console.warn('[theme] Failed to persist theme:', err);
  }
}

$themeToggle.addEventListener('click', toggleTheme);

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function showError(msg) {
  $errorBanner.hidden = false;
  if (msg) $errorBanner.textContent = msg;
  // Hide main content sections
  document.getElementById('stat-cards').style.opacity = '0.4';
  document.getElementById('panel-chart').style.opacity = '0.4';
  document.getElementById('panel-categories').style.opacity = '0.4';
  document.getElementById('panel-table').style.opacity = '0.4';
}

function renderSummary(data) {
  // Remove skeleton class
  [$cardVisitors, $cardRevenue, $cardBestDay, $cardTrend].forEach((el) =>
    el.classList.remove('skeleton')
  );

  $valVisitors.textContent = formatNumber(data.total_visitors);

  // Trend badge on visitors card
  const trendPct = data.trend_pct;
  $trendVisitors.textContent = formatTrend(trendPct);
  $trendVisitors.className = 'stat-card__trend ' +
    (trendPct >= 0 ? 'stat-card__trend--positive' : 'stat-card__trend--negative');

  $valRevenue.textContent = formatCurrency(data.total_revenue);

  $valBestDay.textContent = formatCurrency(data.best_day.revenue);
  $subBestDay.textContent = data.best_day.date ? formatDate(data.best_day.date) : '';

  $valTrend.textContent = formatTrend(trendPct);
  $valTrend.className = 'stat-card__value ' +
    (trendPct >= 0 ? 'trend-positive' : 'trend-negative');
  $valTrend.style.color = trendPct >= 0
    ? 'var(--color-positive)'
    : 'var(--color-negative)';
}

function renderTimeseries(data) {
  if (!chart) {
    chart = new TimeSeriesChart($canvas, $chartContainer);
  }
  chart.setData(data);
}

function renderCategories(data) {
  if (!data || data.length === 0) {
    $categoriesList.innerHTML = '<div class="loading-msg">No data</div>';
    return;
  }

  const maxVal = Math.max(...data.map((d) => d.value));

  $categoriesList.innerHTML = data
    .map((cat) => {
      const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
      return `
        <div class="category-row">
          <div class="category-row__header">
            <span class="category-row__name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
            <span class="category-row__value">${formatNumber(cat.value)}</span>
          </div>
          <div class="category-row__bar-track">
            <div class="category-row__bar-fill" style="width: ${pct.toFixed(1)}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderRecent(data) {
  if (!data || data.length === 0) {
    $recentTbody.innerHTML =
      '<tr><td colspan="4" class="loading-msg">No recent items</td></tr>';
    return;
  }

  $recentTbody.innerHTML = data
    .map(
      (item) => `
      <tr>
        <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
        <td title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
        <td>${formatCurrency(item.value)}</td>
        <td>${formatDateTime(item.created_at)}</td>
      </tr>
    `
    )
    .join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function loadDashboard() {
  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      api.getSummary(),
      api.getTimeseries(),
      api.getCategories(),
      api.getRecent(),
    ]);

    renderSummary(summary);
    renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecent(recent);

    $errorBanner.hidden = true;
  } catch (err) {
    console.error('[dashboard] Failed to load data:', err);
    showError(
      '⚠ Backend unavailable. The dashboard cannot load data. ' +
      'Please ensure the server is running and refresh.'
    );
    // Clear skeleton states
    [$cardVisitors, $cardRevenue, $cardBestDay, $cardTrend].forEach((el) =>
      el.classList.remove('skeleton')
    );
    $valVisitors.textContent = '—';
    $valRevenue.textContent  = '—';
    $valBestDay.textContent  = '—';
    $valTrend.textContent    = '—';
    $categoriesList.innerHTML = '<div class="loading-msg">Unavailable</div>';
    $recentTbody.innerHTML =
      '<tr><td colspan="4" class="loading-msg">Unavailable</td></tr>';
  }
}

// Apply theme from server on load (the inline script in <head> does a best-effort
// pre-paint apply; here we confirm/correct it after JS loads)
async function initTheme() {
  try {
    const { theme } = await api.getSettings();
    applyTheme(theme);
  } catch (_) {
    // Keep whatever the inline script set (or default light)
  }
}

// Run
(async () => {
  await initTheme();
  await loadDashboard();
})();
