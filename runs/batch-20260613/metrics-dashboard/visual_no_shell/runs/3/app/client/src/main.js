import { drawChart, redrawChart } from './chart.js';
import { formatNumber, formatCurrency, formatDate, formatShortDate } from './format.js';

const API_BASE = 'http://localhost:3001';

// ─── State ────────────────────────────────────────────────────────────────────
let currentTheme = 'light';
let timeseriesData = [];
let chartResizeObserver = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $loading = document.getElementById('loading-state');
const $error = document.getElementById('error-state');
const $errorMsg = document.getElementById('error-message');
const $dashboard = document.getElementById('dashboard');
const $themeToggle = document.getElementById('theme-toggle');

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

async function loadTheme() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    if (!res.ok) throw new Error('Settings fetch failed');
    const data = await res.json();
    applyTheme(data.theme || 'light');
  } catch {
    // Default to light if settings unavailable
    applyTheme('light');
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Redraw chart with new theme colors
  if (timeseriesData.length > 0) {
    redrawChart(timeseriesData, next);
  }
  try {
    await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    console.warn('Failed to persist theme:', err);
  }
}

$themeToggle.addEventListener('click', toggleTheme);

// ─── API Fetchers ─────────────────────────────────────────────────────────────
async function fetchJSON(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

// ─── Render: Stat Cards ───────────────────────────────────────────────────────
function renderSummary(summary) {
  // Total Visitors
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-visitors-sub').textContent = 'across all 30 days';

  // Total Revenue
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('stat-revenue-sub').textContent = '30-day total';

  // Best Day
  document.getElementById('stat-bestday').textContent = formatNumber(summary.bestDay.visitors);
  document.getElementById('stat-bestday-sub').textContent = `on ${formatShortDate(summary.bestDay.date)}`;

  // 7-Day Trend
  const trend = summary.trendPct;
  const trendEl = document.getElementById('stat-trend');
  const trendSub = document.getElementById('stat-trend-sub');
  const sign = trend >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${trend}%`;
  trendEl.className = `stat-card__value ${trend >= 0 ? 'trend-positive' : 'trend-negative'}`;
  trendSub.innerHTML = `<span class="${trend >= 0 ? 'trend-positive' : 'trend-negative'}">${trend >= 0 ? '▲' : '▼'}</span> vs previous 7 days`;
}

// ─── Render: Categories ───────────────────────────────────────────────────────
function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';

  const maxVal = categories.reduce((m, c) => Math.max(m, c.value), 0);

  categories.forEach(cat => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    const item = document.createElement('div');
    item.className = 'category-item';
    item.innerHTML = `
      <div class="category-item__header">
        <span class="category-item__name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
        <span class="category-item__value">${formatNumber(cat.value)}</span>
      </div>
      <div class="category-item__bar-track">
        <div class="category-item__bar-fill" style="width: ${pct.toFixed(2)}%"></div>
      </div>
    `;
    container.appendChild(item);
  });
}

// ─── Render: Recent Table ─────────────────────────────────────────────────────
function renderRecent(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
      <td class="td-category" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
      <td class="td-value">${formatCurrency(item.value)}</td>
      <td class="td-date">${formatDate(item.createdAt)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Chart resize handling ────────────────────────────────────────────────────
function setupChartResize() {
  const container = document.getElementById('chart-container');
  if (!container) return;

  if (chartResizeObserver) {
    chartResizeObserver.disconnect();
  }

  chartResizeObserver = new ResizeObserver(() => {
    if (timeseriesData.length > 0) {
      redrawChart(timeseriesData, currentTheme);
    }
  });

  chartResizeObserver.observe(container);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Main Init ────────────────────────────────────────────────────────────────
async function init() {
  // Apply theme before first paint (avoids flash)
  await loadTheme();

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/api/summary'),
      fetchJSON('/api/timeseries'),
      fetchJSON('/api/categories'),
      fetchJSON('/api/recent'),
    ]);

    // Hide loading, show dashboard
    $loading.classList.add('hidden');
    $dashboard.classList.remove('hidden');

    // Render all sections
    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);

    // Store timeseries and draw chart
    timeseriesData = timeseries;
    drawChart(timeseries, currentTheme);
    setupChartResize();

  } catch (err) {
    console.error('Dashboard load failed:', err);
    $loading.classList.add('hidden');
    $error.classList.remove('hidden');
    $errorMsg.textContent = `Could not load dashboard data: ${err.message}. Please ensure the backend server is running on port 3001 and refresh.`;
  }
}

init();
