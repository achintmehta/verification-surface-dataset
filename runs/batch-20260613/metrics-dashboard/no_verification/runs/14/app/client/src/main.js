import './styles.css';
import { api } from './api.js';
import { createChart } from './chart.js';

const app = document.getElementById('app');

// ------------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------------
const numberFmt = new Intl.NumberFormat('en-US');
const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtNumber(n) {
  return numberFmt.format(n);
}
function fmtCurrency(n) {
  return currencyFmt.format(n);
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------
// Theme
// ------------------------------------------------------------------
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme-cache', theme);
  } catch (e) {}
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const next = theme === 'dark' ? 'light' : 'dark';
    btn.querySelector('.icon').textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.querySelector('.label').textContent =
      theme === 'dark' ? 'Light' : 'Dark';
    btn.setAttribute('aria-label', `Switch to ${next} theme`);
  }
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    const saved = await api.saveSettings(next);
    applyTheme(saved.theme);
  } catch (e) {
    // revert if the server rejected the change
    applyTheme(next === 'dark' ? 'light' : 'dark');
  }
  // chart series colors are CSS-driven; redraw to pick up new vars cleanly
  if (chart) chart.render();
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
let chart = null;
let timeseriesData = [];

function renderError(message) {
  app.innerHTML = `
    <div class="page">
      <div class="state error" role="alert">
        <h2>Unable to load dashboard</h2>
        <p>${esc(message)}</p>
        <p class="skeleton">The dashboard renders entirely from the live API.
          Make sure the backend server is running, then retry.</p>
        <button class="retry" id="retry-btn">Retry</button>
      </div>
    </div>`;
  document.getElementById('retry-btn').addEventListener('click', boot);
}

function statCard(label, value, trend) {
  let trendHtml = '';
  if (trend) {
    const cls = trend.dir;
    const arrow = trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '■';
    trendHtml = `<div class="stat-trend ${cls}">${arrow} ${esc(trend.text)}</div>`;
  }
  return `
    <div class="card stat-card">
      <p class="stat-label">${esc(label)}</p>
      <p class="stat-value">${esc(value)}</p>
      ${trendHtml}
    </div>`;
}

function renderDashboard({ summary, categories, recent }) {
  const trendDir =
    summary.trendPct > 0 ? 'up' : summary.trendPct < 0 ? 'down' : 'flat';
  const trendText = `${summary.trendPct > 0 ? '+' : ''}${summary.trendPct}% vs prior 7 days`;

  const bestDayLabel = summary.bestDay
    ? `${fmtNumber(summary.bestDayVisitors)} on ${fmtDate(summary.bestDay)}`
    : '—';

  const maxCat = categories.reduce((m, c) => Math.max(m, c.value), 0) || 1;
  const barsHtml = categories
    .map((c) => {
      const pct = Math.round((c.value / maxCat) * 100);
      return `
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-name" title="${esc(c.name)}">${esc(c.name)}</span>
          <span class="bar-value">${fmtNumber(c.value)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%"></div>
        </div>
      </div>`;
    })
    .join('');

  const rowsHtml = recent
    .map(
      (r) => `
      <tr>
        <td>${esc(r.name)}</td>
        <td class="cat" title="${esc(r.category)}">${esc(r.category)}</td>
        <td class="num">${fmtNumber(r.value)}</td>
        <td>${esc(fmtDateTime(r.createdAt))}</td>
      </tr>`
    )
    .join('');

  app.innerHTML = `
    <div class="page">
      <header class="header">
        <div>
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Last 30 days · refreshed on load</p>
        </div>
        <button class="theme-toggle" id="theme-toggle" type="button">
          <span class="icon">🌙</span>
          <span class="label">Dark</span>
        </button>
      </header>

      <section class="stat-grid">
        ${statCard('Total Visitors', fmtNumber(summary.totalVisitors), {
          dir: trendDir,
          text: trendText,
        })}
        ${statCard('Total Revenue', fmtCurrency(summary.totalRevenue))}
        ${statCard('Best Day', bestDayLabel)}
        ${statCard(
          '7-Day Trend',
          `${summary.trendPct > 0 ? '+' : ''}${summary.trendPct}%`,
          { dir: trendDir, text: 'week over week' }
        )}
      </section>

      <section class="body-grid">
        <div class="panel panel--chart">
          <h2 class="panel-title">Visitors (30 days)</h2>
          <div class="chart-wrap" id="chart"></div>
        </div>

        <div class="panel panel--bars">
          <h2 class="panel-title">Traffic by Category</h2>
          <div class="bars">${barsHtml}</div>
        </div>

        <div class="panel panel--table">
          <h2 class="panel-title">Recent Activity</h2>
          <div class="table-scroll">
            <table class="recent">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Value</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      </section>
    </div>`;

  document
    .getElementById('theme-toggle')
    .addEventListener('click', toggleTheme);

  // re-apply theme so the toggle button reflects current state
  applyTheme(currentTheme);

  // build the chart
  const chartEl = document.getElementById('chart');
  chart = createChart(chartEl, () => timeseriesData);
  chart.render();
}

// ------------------------------------------------------------------
// Resize handling: redraw chart to fit its container
// ------------------------------------------------------------------
let resizeRaf = null;
function onResize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (chart) chart.render();
  });
}
window.addEventListener('resize', onResize);

// Use ResizeObserver where available for container-driven redraws.
let ro = null;
function observeChart() {
  if (ro) ro.disconnect();
  const chartEl = document.getElementById('chart');
  if (chartEl && 'ResizeObserver' in window) {
    ro = new ResizeObserver(() => {
      if (chart) chart.render();
    });
    ro.observe(chartEl);
  }
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
async function boot() {
  app.innerHTML = `<div class="page"><div class="state skeleton">Loading dashboard…</div></div>`;
  try {
    // Settings first so the theme is applied as early as possible.
    const settings = await api.settings();
    applyTheme(settings.theme === 'dark' ? 'dark' : 'light');

    const [summary, timeseries, categories, recent] = await Promise.all([
      api.summary(),
      api.timeseries(),
      api.categories(),
      api.recent(),
    ]);

    if (!summary || !timeseries || timeseries.length === 0) {
      renderError('The API returned no data.');
      return;
    }

    timeseriesData = timeseries;
    renderDashboard({ summary, categories, recent });
    observeChart();
  } catch (err) {
    renderError(err && err.message ? err.message : 'Network error');
  }
}

boot();
