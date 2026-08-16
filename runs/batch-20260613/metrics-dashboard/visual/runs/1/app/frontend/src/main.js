import { TimeSeriesChart } from './chart.js';

const API = '/api';

// ─── State ────────────────────────────────────────────────────────────────────
let chart = null;
let currentTheme = 'light';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $loading   = document.getElementById('loading-state');
const $error     = document.getElementById('error-state');
const $errorMsg  = document.getElementById('error-message');
const $dashboard = document.getElementById('dashboard');
const $retryBtn  = document.getElementById('retry-btn');
const $themeBtn  = document.getElementById('theme-toggle');

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Redraw chart with new colours
  if (chart) {
    requestAnimationFrame(() => chart.draw());
  }
}

async function loadTheme() {
  try {
    const res = await fetch(`${API}/settings`);
    if (!res.ok) throw new Error('settings fetch failed');
    const { theme } = await res.json();
    applyTheme(theme || 'light');
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    console.warn('Failed to persist theme:', err);
  }
}

$themeBtn.addEventListener('click', toggleTheme);

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
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
  // dateStr may be "2024-01-15" or "2024-01-15T00:00:00.000Z"
  const s = String(dateStr).slice(0, 10); // take only YYYY-MM-DD
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d); // local time, no timezone shift
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Stat cards ───────────────────────────────────────────────────────────────

function renderSummary(data) {
  // Total visitors
  document.getElementById('stat-visitors').textContent = fmtNumber(data.total_visitors);
  document.getElementById('stat-visitors-sub').textContent = 'across 30 days';

  // Total revenue
  document.getElementById('stat-revenue').textContent = fmtCurrency(data.total_revenue);
  document.getElementById('stat-revenue-sub').textContent = 'across 30 days';

  // Best day
  document.getElementById('stat-best-day').textContent = fmtCurrency(data.best_day.revenue);
  document.getElementById('stat-best-day-sub').textContent = fmtDate(data.best_day.date);

  // 7-day trend
  const pct = data.trend_7d_pct;
  const trendEl = document.getElementById('stat-trend');
  const trendSub = document.getElementById('stat-trend-sub');

  const sign = pct > 0 ? '+' : '';
  trendEl.textContent = `${sign}${pct}%`;

  const cls = pct > 0 ? 'trend-up' : pct < 0 ? 'trend-down' : 'trend-flat';
  trendEl.className = `stat-card__value ${cls}`;

  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '▶';
  trendSub.innerHTML = `<span class="${cls}" aria-hidden="true">${arrow}</span>&nbsp;vs prior 7 days`;
}

// ─── Time-series chart ────────────────────────────────────────────────────────

function renderChart(data) {
  const canvas = document.getElementById('timeseries-chart');
  if (chart) {
    chart.update(data);
  } else {
    chart = new TimeSeriesChart(canvas, data);
  }
}

// ─── Category bars ────────────────────────────────────────────────────────────

function renderCategories(data) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';

  if (!data || data.length === 0) {
    container.textContent = 'No category data.';
    return;
  }

  // Use sqrt scale so small values remain visible alongside very large ones
  const sqrtValues = data.map(d => Math.sqrt(Math.max(0, d.value)));
  const maxSqrt    = Math.max(...sqrtValues);

  for (let i = 0; i < data.length; i++) {
    const cat = data[i];
    // Linear pct for aria, sqrt pct for visual bar width
    const linearPct = data[0].value > 0 ? (cat.value / data[0].value) * 100 : 0;
    const visualPct = maxSqrt > 0 ? (sqrtValues[i] / maxSqrt) * 100 : 0;
    // Ensure minimum visible bar of 4%
    const barPct = Math.max(visualPct, cat.value > 0 ? 4 : 0);

    const item = document.createElement('div');
    item.className = 'category-item';
    item.setAttribute('role', 'listitem');

    item.innerHTML = `
      <div class="category-item__header">
        <span class="category-item__name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
        <span class="category-item__value">${fmtCurrency(cat.value)}</span>
      </div>
      <div class="category-item__bar-track" role="progressbar" aria-valuenow="${Math.round(linearPct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(cat.name)}: ${fmtCurrency(cat.value)}">
        <div class="category-item__bar-fill" style="width: ${barPct.toFixed(1)}%"></div>
      </div>
    `;

    container.appendChild(item);
  }
}

// ─── Recent items table ───────────────────────────────────────────────────────

function renderTable(data) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  if (!data || data.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" style="text-align:center;color:var(--color-text-muted)">No recent items.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const item of data) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td><span class="category-badge" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
      <td class="col-value">${fmtCurrency(item.value)}</td>
      <td class="col-date">${fmtDateTime(item.created_at)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Error / loading states ───────────────────────────────────────────────────

function showLoading() {
  $loading.classList.remove('hidden');
  $error.classList.add('hidden');
  $dashboard.classList.add('hidden');
}

function showError(msg) {
  $loading.classList.add('hidden');
  $error.classList.remove('hidden');
  $dashboard.classList.add('hidden');
  $errorMsg.textContent = msg || 'The backend server is not reachable. Please ensure the server is running and try again.';
}

function showDashboard() {
  $loading.classList.add('hidden');
  $error.classList.add('hidden');
  $dashboard.classList.remove('hidden');
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function fetchAll() {
  const [summary, timeseries, categories, recent] = await Promise.all([
    fetch(`${API}/summary`).then(r => { if (!r.ok) throw new Error(`summary: ${r.status}`); return r.json(); }),
    fetch(`${API}/timeseries`).then(r => { if (!r.ok) throw new Error(`timeseries: ${r.status}`); return r.json(); }),
    fetch(`${API}/categories`).then(r => { if (!r.ok) throw new Error(`categories: ${r.status}`); return r.json(); }),
    fetch(`${API}/recent`).then(r => { if (!r.ok) throw new Error(`recent: ${r.status}`); return r.json(); }),
  ]);
  return { summary, timeseries, categories, recent };
}

async function loadDashboard() {
  showLoading();
  try {
    const { summary, timeseries, categories, recent } = await fetchAll();
    renderSummary(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderTable(recent);
    showDashboard();
  } catch (err) {
    console.error('Dashboard load failed:', err);
    showError(
      'Unable to reach the backend server. Please ensure it is running on port 3001 and try again.'
    );
  }
}

// ─── Retry ────────────────────────────────────────────────────────────────────

$retryBtn.addEventListener('click', loadDashboard);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Load theme first (before first paint of dashboard)
  await loadTheme();
  await loadDashboard();
}

init();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
