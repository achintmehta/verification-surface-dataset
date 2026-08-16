import { drawChart } from './chart.js';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

// ============================================================
// State
// ============================================================
let currentTheme = 'light';
let timeseriesData = [];
let resizeTimer = null;

// ============================================================
// DOM refs
// ============================================================
const $body          = document.body;
const $themeBtn      = document.getElementById('theme-toggle');
const $loadingState  = document.getElementById('loading-state');
const $dashboard     = document.getElementById('dashboard');
const $errorBanner   = document.getElementById('error-banner');
const $errorMessage  = document.getElementById('error-message');

// Stat cards
const $statVisitors  = document.getElementById('stat-visitors');
const $statRevenue   = document.getElementById('stat-revenue');
const $statBestVisitors = document.getElementById('stat-best-visitors');
const $statBestDate  = document.getElementById('stat-best-date');
const $statTrendPct  = document.getElementById('stat-trend-pct');
const $statTrend     = document.getElementById('stat-trend');

// Chart
const $canvas        = document.getElementById('timeseries-canvas');

// Categories
const $categoriesList = document.getElementById('categories-list');

// Table
const $recentTbody   = document.getElementById('recent-tbody');

// ============================================================
// Utilities
// ============================================================
function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

function showError(msg) {
  $errorMessage.textContent = msg;
  $errorBanner.hidden = false;
}

function hideError() {
  $errorBanner.hidden = true;
}

// ============================================================
// Theme
// ============================================================
function applyTheme(theme) {
  currentTheme = theme;
  $body.classList.remove('theme-light', 'theme-dark');
  $body.classList.add(`theme-${theme}`);
  // Redraw chart with new theme colors
  if (timeseriesData.length > 0) {
    // Small delay to let CSS vars update
    requestAnimationFrame(() => drawChart($canvas, timeseriesData));
  }
}

async function loadTheme() {
  try {
    const data = await apiFetch('/api/settings');
    applyTheme(data.theme || 'light');
  } catch {
    // Default to light if server unreachable
    applyTheme('light');
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    console.warn('[theme] Failed to persist theme:', err);
  }
}

// ============================================================
// Render functions
// ============================================================
function renderSummary(data) {
  $statVisitors.textContent = fmtNumber(data.total_visitors);
  $statRevenue.textContent  = fmtCurrency(parseFloat(data.total_revenue));

  $statBestVisitors.textContent = fmtNumber(data.best_day.visitors);
  $statBestDate.textContent     = fmtDate(data.best_day.date);

  const pct = parseFloat(data.trend_7day_pct);
  const sign = pct >= 0 ? '+' : '';
  $statTrendPct.textContent = `${sign}${pct.toFixed(1)}%`;

  // Trend badge on visitors card
  $statTrend.textContent = `${sign}${pct.toFixed(1)}% vs prev 7d`;
  $statTrend.className = 'stat-card__trend ' + (pct >= 0 ? 'positive' : 'negative');

  // Color the trend card value
  $statTrendPct.style.color = pct >= 0
    ? 'var(--color-positive)'
    : 'var(--color-negative)';
}

function renderTimeseries(data) {
  timeseriesData = data;
  drawChart($canvas, data);
}

function renderCategories(data) {
  if (!data || data.length === 0) {
    $categoriesList.innerHTML = '<p style="color:var(--color-text-muted);font-size:0.875rem;">No data</p>';
    return;
  }

  const maxVal = Math.max(...data.map((d) => d.value));

  $categoriesList.innerHTML = data
    .map((cat) => {
      const pct = maxVal > 0 ? ((cat.value / maxVal) * 100).toFixed(1) : 0;
      const valStr = fmtNumber(cat.value);
      // Escape HTML
      const safeName = cat.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
        <div class="category-row">
          <div class="category-row__header">
            <span class="category-row__name" title="${safeName}">${safeName}</span>
            <span class="category-row__value">${valStr}</span>
          </div>
          <div class="category-row__bar-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${safeName}: ${valStr}">
            <div class="category-row__bar-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderRecent(data) {
  if (!data || data.length === 0) {
    $recentTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--color-text-muted);">No recent items</td></tr>';
    return;
  }

  $recentTbody.innerHTML = data
    .map((item) => {
      const safeName = item.name.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const safeCat  = item.category.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `
        <tr>
          <td title="${safeName}">${safeName}</td>
          <td title="${safeCat}">${safeCat}</td>
          <td>${fmtCurrency(item.value)}</td>
          <td>${fmtDateShort(item.created_at)}</td>
        </tr>
      `;
    })
    .join('');
}

// ============================================================
// Data loading
// ============================================================
async function loadDashboard() {
  $loadingState.hidden = false;
  $dashboard.hidden = true;
  hideError();

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/api/summary'),
      apiFetch('/api/timeseries'),
      apiFetch('/api/categories'),
      apiFetch('/api/recent'),
    ]);

    renderSummary(summary);
    renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecent(recent);

    $loadingState.hidden = true;
    $dashboard.hidden = false;
  } catch (err) {
    console.error('[dashboard] Load failed:', err);
    $loadingState.hidden = true;
    showError(
      'Unable to reach the server. Please ensure the backend is running and refresh the page.'
    );
  }
}

// ============================================================
// Resize handling
// ============================================================
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (timeseriesData.length > 0) {
      drawChart($canvas, timeseriesData);
    }
  }, 100);
}

// ============================================================
// Init
// ============================================================
async function init() {
  // Apply theme before data loads to avoid flash
  await loadTheme();

  // Wire up theme toggle
  $themeBtn.addEventListener('click', toggleTheme);

  // Load all dashboard data
  await loadDashboard();

  // Resize observer for chart
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onResize);
    ro.observe(document.getElementById('chart-container'));
  } else {
    window.addEventListener('resize', onResize);
  }
}

init();
