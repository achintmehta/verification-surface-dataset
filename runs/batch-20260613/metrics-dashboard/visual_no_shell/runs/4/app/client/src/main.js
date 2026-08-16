import { drawChart, resizeChart } from './chart.js';

const API = 'http://localhost:3001';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, opts = {}) {
  return new Intl.NumberFormat('en-US', opts).format(n);
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
  // dateStr may be ISO date "2024-01-15" or full ISO timestamp
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Theme ─────────────────────────────────────────────────────────────────────

let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

async function loadTheme() {
  try {
    const res = await fetch(`${API}/api/settings`);
    if (!res.ok) throw new Error('settings fetch failed');
    const { theme } = await res.json();
    applyTheme(theme);
  } catch {
    // default to light; don't block render
    applyTheme('light');
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Redraw chart with new theme colours
  if (window.__chartData) {
    drawChart(window.__chartData, currentTheme);
  }
  try {
    await fetch(`${API}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch {
    // non-fatal
  }
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderSummary(data) {
  // Total visitors
  document.getElementById('stat-visitors').textContent = fmt(data.total_visitors);
  document.getElementById('stat-visitors-sub').textContent = '30-day total';

  // Total revenue
  document.getElementById('stat-revenue').textContent = fmtCurrency(data.total_revenue);
  document.getElementById('stat-revenue-sub').textContent = '30-day total';

  // Best day
  document.getElementById('stat-best-day').textContent = fmtCurrency(data.best_day.revenue);
  document.getElementById('stat-best-day-sub').textContent = fmtDate(data.best_day.date);

  // 7-day trend
  const trendEl  = document.getElementById('stat-trend');
  const trendSub = document.getElementById('stat-trend-sub');
  const pct = data.trend_pct;
  const sign = pct >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${pct.toFixed(1)}%`;
  trendEl.className = 'stat-card__value ' + (pct >= 0 ? 'trend-up' : 'trend-down');
  trendSub.textContent = 'vs prior 7 days (revenue)';
}

function renderCategories(rows) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';

  const maxVal = Math.max(...rows.map(r => Number(r.value)));

  rows.forEach(row => {
    const pct = maxVal > 0 ? (Number(row.value) / maxVal) * 100 : 0;

    const item = document.createElement('div');
    item.className = 'category-item';
    item.setAttribute('role', 'listitem');

    item.innerHTML = `
      <div class="category-item__header">
        <span class="category-item__name" title="${escHtml(row.name)}">${escHtml(row.name)}</span>
        <span class="category-item__value">${fmt(Number(row.value))}</span>
      </div>
      <div class="category-item__bar-track" role="progressbar" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100">
        <div class="category-item__bar-fill" style="width: ${pct.toFixed(2)}%"></div>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderTable(rows) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(row.name)}</td>
      <td class="category-cell" title="${escHtml(row.category)}">${escHtml(row.category)}</td>
      <td class="num-col">${fmtCurrency(row.value)}</td>
      <td class="date-cell">${fmtDate(row.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchAll() {
  const [summary, timeseries, categories, recent] = await Promise.all([
    fetch(`${API}/api/summary`).then(r => { if (!r.ok) throw new Error('summary'); return r.json(); }),
    fetch(`${API}/api/timeseries`).then(r => { if (!r.ok) throw new Error('timeseries'); return r.json(); }),
    fetch(`${API}/api/categories`).then(r => { if (!r.ok) throw new Error('categories'); return r.json(); }),
    fetch(`${API}/api/recent`).then(r => { if (!r.ok) throw new Error('recent'); return r.json(); }),
  ]);
  return { summary, timeseries, categories, recent };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  // Apply persisted theme before first paint
  await loadTheme();

  // Wire up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  const loadingEl = document.getElementById('loading-state');
  const dashboardEl = document.getElementById('dashboard');
  const errorEl = document.getElementById('error-banner');

  try {
    const { summary, timeseries, categories, recent } = await fetchAll();

    // Hide loading, show dashboard
    loadingEl.hidden = true;
    dashboardEl.hidden = false;

    renderSummary(summary);
    renderCategories(categories);
    renderTable(recent);

    // Store timeseries for theme-change redraws
    window.__chartData = timeseries;

    // Draw after layout settles
    requestAnimationFrame(() => {
      drawChart(timeseries, currentTheme);
    });

    // Redraw chart on resize (debounced)
    let rafId = null;
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (window.__chartData) {
          drawChart(window.__chartData, currentTheme);
        }
      });
    });
    ro.observe(document.getElementById('chart-container'));

  } catch (err) {
    console.error('Dashboard load error:', err);
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

init();
