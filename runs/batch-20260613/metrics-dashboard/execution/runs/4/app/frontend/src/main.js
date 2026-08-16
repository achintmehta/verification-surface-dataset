import { renderChart, destroyChart } from './chart.js';
import { formatNumber, formatCurrency, formatDate, formatPercent } from './format.js';

const API = '/api';

// ─── State ───────────────────────────────────────────────────────────────────
let currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
let timeseriesData = [];

// ─── Theme toggle ─────────────────────────────────────────────────────────────
const themeToggle = document.getElementById('theme-toggle');

themeToggle.addEventListener('click', async () => {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    console.warn('Could not persist theme:', err);
  }
});

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Redraw chart with new theme colours
  if (timeseriesData.length > 0) {
    renderChart('timeseries-canvas', timeseriesData);
  }
}

// ─── Error handling ───────────────────────────────────────────────────────────
function showError() {
  document.getElementById('error-banner').hidden = false;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function fetchJSON(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Render summary cards ─────────────────────────────────────────────────────
function renderSummary(data) {
  // Remove skeleton class
  ['card-visitors', 'card-revenue', 'card-bestday', 'card-trend'].forEach(id => {
    document.getElementById(id).classList.remove('skeleton');
  });

  document.getElementById('val-visitors').textContent = formatNumber(data.total_visitors);
  document.getElementById('sub-visitors').textContent = 'across all 30 days';

  document.getElementById('val-revenue').textContent = formatCurrency(data.total_revenue);
  document.getElementById('sub-revenue').textContent = 'total 30-day revenue';

  document.getElementById('val-bestday').textContent = formatCurrency(data.best_day.revenue);
  document.getElementById('sub-bestday').textContent = formatDate(data.best_day.date);

  const pct = data.trend_7day_pct;
  const trendEl = document.getElementById('val-trend');
  trendEl.textContent = formatPercent(pct);
  if (pct > 0) {
    trendEl.className = 'stat-value trend-up';
  } else if (pct < 0) {
    trendEl.className = 'stat-value trend-down';
  } else {
    trendEl.className = 'stat-value trend-neutral';
  }
  document.getElementById('sub-trend').textContent = 'vs prior 7 days';
}

// ─── Render categories ────────────────────────────────────────────────────────
function renderCategories(data) {
  const container = document.getElementById('categories-list');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="loading-placeholder">No data</div>';
    return;
  }

  const max = Math.max(...data.map(d => Number(d.value)));
  container.innerHTML = '';

  data.forEach(cat => {
    const pct = max > 0 ? (Number(cat.value) / max) * 100 : 0;
    const row = document.createElement('div');
    row.className = 'category-row';
    row.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
        <span class="category-value">${formatNumber(cat.value)}</span>
      </div>
      <div class="bar-track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(cat.name)}: ${formatNumber(cat.value)}">
        <div class="bar-fill" style="width: ${pct.toFixed(2)}%"></div>
      </div>
    `;
    container.appendChild(row);
  });
}

// ─── Render recent items table ────────────────────────────────────────────────
function renderRecent(data) {
  const tbody = document.getElementById('recent-tbody');
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="loading-placeholder">No data</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  data.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
      <td title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
      <td class="col-num">${formatCurrency(item.value)}</td>
      <td class="col-date">${formatDate(item.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Chart resize observer ────────────────────────────────────────────────────
function setupChartResize() {
  const container = document.getElementById('timeseries-container');
  if (!container) return;

  const ro = new ResizeObserver(() => {
    if (timeseriesData.length > 0) {
      renderChart('timeseries-canvas', timeseriesData);
    }
  });
  ro.observe(container);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  // Read theme from DOM (set by inline script before first paint)
  currentTheme = document.documentElement.getAttribute('data-theme') || 'light';

  setupChartResize();

  let hasError = false;

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent'),
    ]);

    renderSummary(summary);

    timeseriesData = timeseries;
    renderChart('timeseries-canvas', timeseries);

    renderCategories(categories);
    renderRecent(recent);
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    hasError = true;
    showError();

    // Clear skeleton states to show empty/error UI
    ['card-visitors', 'card-revenue', 'card-bestday', 'card-trend'].forEach(id => {
      document.getElementById(id).classList.remove('skeleton');
    });
    document.getElementById('val-visitors').textContent = '—';
    document.getElementById('val-revenue').textContent = '—';
    document.getElementById('val-bestday').textContent = '—';
    document.getElementById('val-trend').textContent = '—';
    document.getElementById('categories-list').innerHTML = '<div class="loading-placeholder">Unavailable</div>';
    document.getElementById('recent-tbody').innerHTML = '<tr><td colspan="4" class="loading-placeholder">Unavailable</td></tr>';
  }
}

init();
