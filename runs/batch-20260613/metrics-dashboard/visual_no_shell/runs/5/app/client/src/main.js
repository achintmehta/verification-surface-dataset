import { initChart } from './chart.js';

const API = 'http://localhost:3001';

// ── Theme ─────────────────────────────────────────────────────────────────────

let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

async function loadTheme() {
  try {
    const res = await fetch(`${API}/api/settings`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('settings fetch failed');
    const data = await res.json();
    applyTheme(data.theme || 'light');
  } catch {
    // Keep whatever the inline script set (or default light)
    const existing = document.documentElement.getAttribute('data-theme');
    currentTheme = existing === 'dark' ? 'dark' : 'light';
  }
}

async function persistTheme(theme) {
  try {
    await fetch(`${API}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // best-effort
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  await persistTheme(next);
  // Redraw chart with new theme colours
  if (window.__chartData) {
    drawChart(window.__chartData);
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

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
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtShortDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Chart ─────────────────────────────────────────────────────────────────────

let resizeObserver = null;

function drawChart(rows) {
  window.__chartData = rows;
  const container = document.getElementById('chart-container');
  if (!container) return;
  initChart(container, rows, currentTheme);
}

function setupChartResize() {
  const container = document.getElementById('chart-container');
  if (!container) return;

  if (resizeObserver) resizeObserver.disconnect();

  resizeObserver = new ResizeObserver(() => {
    if (window.__chartData) {
      drawChart(window.__chartData);
    }
  });
  resizeObserver.observe(container);
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = fmtNumber(data.total_visitors);

  document.getElementById('stat-revenue').textContent = fmtCurrency(data.total_revenue);

  document.getElementById('stat-best-day').textContent = fmtCurrency(data.best_day.revenue);
  document.getElementById('stat-best-day-sub').textContent = fmtDate(data.best_day.date);

  const pct = data.trend_pct;
  const sign = pct >= 0 ? '+' : '';
  const trendEl = document.getElementById('stat-trend');
  trendEl.textContent = `${sign}${pct}%`;
  trendEl.style.color = pct >= 0
    ? 'var(--color-positive)'
    : 'var(--color-negative)';
}

function renderCategories(rows) {
  const container = document.getElementById('categories-list');
  if (!container) return;
  container.innerHTML = '';

  const max = rows.reduce((m, r) => Math.max(m, Number(r.value)), 0);

  rows.forEach(row => {
    const pct = max > 0 ? (Number(row.value) / max) * 100 : 0;
    const item = document.createElement('div');
    item.className = 'category-item';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      <div class="category-item__header">
        <span class="category-item__name" title="${escHtml(row.name)}">${escHtml(row.name)}</span>
        <span class="category-item__value">${fmtCurrency(row.value)}</span>
      </div>
      <div class="category-item__bar-track"
           role="progressbar"
           aria-valuenow="${Math.round(pct)}"
           aria-valuemin="0"
           aria-valuemax="100"
           aria-label="${escHtml(row.name)}: ${Math.round(pct)}% of maximum">
        <div class="category-item__bar-fill" style="width: ${pct.toFixed(1)}%"></div>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderRecentTable(rows) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${escHtml(row.name)}">${escHtml(row.name)}</td>
      <td class="category-col" title="${escHtml(row.category)}">${escHtml(row.category)}</td>
      <td class="num-col">${fmtCurrency(row.value)}</td>
      <td>${fmtShortDate(row.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Main fetch & render ───────────────────────────────────────────────────────

async function loadDashboard() {
  const loadingEl = document.getElementById('loading-state');
  const dashEl    = document.getElementById('dashboard');
  const errorEl   = document.getElementById('error-banner');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const [summary, timeseries, categories, recent] = await Promise.all([
      fetch(`${API}/api/summary`,    { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
      fetch(`${API}/api/timeseries`, { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
      fetch(`${API}/api/categories`, { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
      fetch(`${API}/api/recent`,     { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
    ]);

    clearTimeout(timeout);

    renderSummary(summary);
    renderCategories(categories);
    renderRecentTable(recent);

    // Show dashboard before drawing chart so container has real dimensions
    loadingEl.hidden = true;
    dashEl.hidden = false;

    // Set up resize observer first, then draw
    setupChartResize();

    // Draw chart after layout paint — double rAF ensures the browser has
    // performed layout so the container has real pixel dimensions.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        drawChart(timeseries);
        // Retry once more after a short delay in case the container was
        // still 0×0 (e.g. inside an iframe that hasn't fully laid out).
        setTimeout(() => {
          const container = document.getElementById('chart-container');
          if (container && container.clientWidth > 0 && !container.querySelector('svg.chart-svg')) {
            drawChart(timeseries);
          }
        }, 200);
      });
    });

  } catch (err) {
    console.error('Dashboard load error:', err);
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  // The inline <script> in index.html already applied the persisted theme
  // via a synchronous XHR. Sync our JS state with whatever is on the element.
  const existing = document.documentElement.getAttribute('data-theme');
  currentTheme = existing === 'dark' ? 'dark' : 'light';

  // Wire up theme toggle
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleTheme);

  // Load data (this also confirms the theme via async fetch inside loadDashboard
  // indirectly — the toggle will always persist correctly going forward).
  await loadDashboard();
}

boot();
