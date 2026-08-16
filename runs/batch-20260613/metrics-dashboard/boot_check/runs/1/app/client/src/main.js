import './style.css';
import { getSummary, getTimeseries, getCategories, getRecent, getSettings, putSettings } from './api.js';
import { TimeSeriesChart } from './chart.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const body            = document.body;
const loadingState    = document.getElementById('loading-state');
const errorState      = document.getElementById('error-state');
const errorMessage    = document.getElementById('error-message');
const dashboard       = document.getElementById('dashboard');
const retryBtn        = document.getElementById('retry-btn');
const themeToggle     = document.getElementById('theme-toggle');

// Stat card values
const statVisitors    = document.getElementById('stat-visitors');
const statRevenue     = document.getElementById('stat-revenue');
const statBestDay     = document.getElementById('stat-best-day');
const statTrend       = document.getElementById('stat-trend');
const trendVisitors   = document.getElementById('trend-visitors');
const trendRevenue    = document.getElementById('trend-revenue');
const trendBestDay    = document.getElementById('trend-best-day');
const trendIndicator  = document.getElementById('trend-indicator');

// Chart
const chartContainer  = document.getElementById('chart-container');
const chartSvg        = document.getElementById('timeseries-chart');

// Categories
const categoriesList  = document.getElementById('categories-list');

// Table
const recentTbody     = document.getElementById('recent-tbody');

// ── State ─────────────────────────────────────────────────────────────────────
let currentTheme = 'light';
let chartInstance = null;

// ── Formatters ────────────────────────────────────────────────────────────────
function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function formatCurrency(n) {
  if (n >= 1_000_000) {
    return '$' + (n / 1_000_000).toFixed(2) + 'M';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatDate(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateShort(isoStr) {
  // Handle both YYYY-MM-DD and full ISO strings
  const str = String(isoStr).slice(0, 10);
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelativeDate(isoStr) {
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return formatDate(isoStr);
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  body.classList.remove('theme-light', 'theme-dark');
  body.classList.add(`theme-${theme}`);
  // Persist provisional theme in localStorage to avoid flash on next load
  try { localStorage.setItem('theme-provisional', theme); } catch (_) {}
  themeToggle.setAttribute('aria-label', `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`);
  // Re-render chart with new theme colors
  if (chartInstance) {
    chartInstance.render();
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await putSettings({ theme: newTheme });
  } catch (err) {
    console.warn('Failed to persist theme:', err);
  }
}

// ── Render helpers ────────────────────────────────────────────────────────────
function renderSummary(summary) {
  // Total visitors
  statVisitors.textContent = formatNumber(summary.total_visitors);
  trendVisitors.className = 'stat-card__trend';
  trendVisitors.textContent = '30-day total';

  // Total revenue
  statRevenue.textContent = formatCurrency(summary.total_revenue);
  trendRevenue.className = 'stat-card__trend';
  trendRevenue.textContent = '30-day total';

  // Best day
  statBestDay.textContent = formatCurrency(summary.best_day_revenue);
  trendBestDay.className = 'stat-card__trend';
  trendBestDay.textContent = formatDateShort(summary.best_day_date);

  // 7-day trend
  const pct = summary.trend_pct;
  const sign = pct > 0 ? '+' : '';
  statTrend.textContent = `${sign}${pct}%`;

  const trendClass = pct > 0 ? 'trend--up' : pct < 0 ? 'trend--down' : 'trend--neutral';
  const trendArrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
  statTrend.className = `stat-card__value ${trendClass}`;
  trendIndicator.className = `stat-card__trend ${trendClass}`;
  trendIndicator.textContent = `${trendArrow} vs previous 7 days`;
}

function renderCategories(categories) {
  categoriesList.innerHTML = '';
  if (!categories || categories.length === 0) {
    categoriesList.innerHTML = '<p style="color:var(--color-text-muted);font-size:0.875rem;">No category data.</p>';
    return;
  }

  const maxVal = Math.max(...categories.map(c => c.value));

  for (const cat of categories) {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;

    const item = document.createElement('div');
    item.className = 'category-item';
    item.setAttribute('role', 'listitem');

    const header = document.createElement('div');
    header.className = 'category-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'category-name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name; // show full name on hover

    const valueEl = document.createElement('span');
    valueEl.className = 'category-value';
    valueEl.textContent = formatNumber(cat.value);

    header.appendChild(nameEl);
    header.appendChild(valueEl);

    const track = document.createElement('div');
    track.className = 'category-bar-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuenow', cat.value);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', maxVal);
    track.setAttribute('aria-label', `${cat.name}: ${formatNumber(cat.value)}`);

    const fill = document.createElement('div');
    fill.className = 'category-bar-fill';
    fill.style.width = `${pct.toFixed(1)}%`;

    track.appendChild(fill);
    item.appendChild(header);
    item.appendChild(track);
    categoriesList.appendChild(item);
  }
}

function renderTable(items) {
  recentTbody.innerHTML = '';
  if (!items || items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.style.textAlign = 'center';
    td.style.color = 'var(--color-text-muted)';
    td.textContent = 'No recent items.';
    tr.appendChild(td);
    recentTbody.appendChild(tr);
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'col-name';
    tdName.textContent = item.name;

    const tdCat = document.createElement('td');
    tdCat.className = 'col-category';
    tdCat.textContent = item.category;
    tdCat.title = item.category;

    const tdVal = document.createElement('td');
    tdVal.className = 'col-value';
    tdVal.textContent = formatCurrency(item.value);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = formatRelativeDate(item.created_at);
    tdDate.title = formatDate(item.created_at);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    recentTbody.appendChild(tr);
  }
}

// ── UI state helpers ──────────────────────────────────────────────────────────
function showLoading() {
  loadingState.hidden = false;
  errorState.hidden   = true;
  dashboard.hidden    = true;
}

function showError(msg) {
  loadingState.hidden = true;
  errorState.hidden   = false;
  dashboard.hidden    = true;
  errorMessage.textContent = msg || 'The backend server is not reachable. Please ensure the server is running and try again.';
}

function showDashboard() {
  loadingState.hidden = true;
  errorState.hidden   = true;
  dashboard.hidden    = false;
}

// ── Main load ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  showLoading();

  try {
    // Load settings first so theme is applied before data renders
    try {
      const settings = await getSettings();
      applyTheme(settings.theme || 'light');
    } catch {
      // If settings fail, keep current theme but continue loading
    }

    // Load all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);

    // Render data
    renderSummary(summary);
    renderCategories(categories);
    renderTable(recent);

    // Show dashboard before rendering chart (chart needs layout dimensions)
    showDashboard();

    // Initialize or update chart
    if (!chartInstance) {
      chartInstance = new TimeSeriesChart(chartSvg, chartContainer);
    }
    chartInstance.setData(timeseries);

  } catch (err) {
    console.error('Dashboard load error:', err);
    let msg = 'Unable to connect to the backend server.';
    if (err.message) {
      msg += ` (${err.message})`;
    }
    msg += ' Please ensure the server is running on port 3001 and try again.';
    showError(msg);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
themeToggle.addEventListener('click', toggleTheme);
retryBtn.addEventListener('click', loadDashboard);

// ── Boot: apply provisional theme immediately to avoid flash ──────────────────
(function applyProvisionalTheme() {
  try {
    const saved = localStorage.getItem('theme-provisional');
    if (saved === 'dark' || saved === 'light') {
      body.classList.remove('theme-light', 'theme-dark');
      body.classList.add(`theme-${saved}`);
      currentTheme = saved;
    }
  } catch (_) {}
})();

// Kick off load
loadDashboard();
