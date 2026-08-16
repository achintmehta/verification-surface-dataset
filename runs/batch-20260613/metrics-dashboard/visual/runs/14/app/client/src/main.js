import {
  fetchSummary,
  fetchTimeseries,
  fetchCategories,
  fetchRecent,
  fetchSettings,
  saveSettings,
} from './api.js';
import { createTimeSeriesChart } from './chart.js';

const app = document.getElementById('app');
let chartInstance = null;
let currentTheme = 'light';

// ---------------- formatting helpers ----------------
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtInt(n) {
  return nf.format(Math.round(n));
}
function fmtMoney(n) {
  return cf.format(n);
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

// ---------------- theme ----------------
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch (e) {}
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const icon = btn.querySelector('.icon');
    const label = btn.querySelector('.label');
    if (theme === 'dark') {
      icon.textContent = '☀️';
      label.textContent = 'Light';
    } else {
      icon.textContent = '🌙';
      label.textContent = 'Dark';
    }
  }
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    const saved = await saveSettings(next);
    applyTheme(saved.theme);
  } catch (e) {
    // revert on failure
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
    console.error('Failed to persist theme', e);
  }
}

// ---------------- rendering ----------------
function headerHTML() {
  return `
    <header class="header">
      <div>
        <h1>Metrics Dashboard</h1>
        <div class="sub">Last 30 days &middot; seeded analytics</div>
      </div>
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle theme">
        <span class="icon">🌙</span><span class="label">Dark</span>
      </button>
    </header>
  `;
}

function renderLoading() {
  app.innerHTML = `
    ${headerHTML()}
    <div class="state"><div class="skeleton" style="width:200px;margin:0 auto 10px"></div>Loading dashboard…</div>
  `;
  wireHeader();
}

function renderError(message) {
  app.innerHTML = `
    ${headerHTML()}
    <div class="card">
      <div class="state error">
        <h2>Unable to load dashboard</h2>
        <p>${message || 'The dashboard could not reach the data API.'}</p>
        <p>Make sure the backend server is running, then retry.</p>
        <button class="retry-btn" id="retry">Retry</button>
      </div>
    </div>
  `;
  wireHeader();
  const retry = document.getElementById('retry');
  if (retry) retry.addEventListener('click', () => init());
}

function statCard(label, value, sub, trend) {
  let trendHTML = '';
  if (trend != null) {
    const cls = trend >= 0 ? 'pos' : 'neg';
    const arrow = trend >= 0 ? '▲' : '▼';
    trendHTML = `<div class="stat-trend ${cls}">${arrow} ${Math.abs(trend).toFixed(
      1
    )}% vs prev 7d</div>`;
  }
  const subHTML = sub ? `<div class="stat-sub">${sub}</div>` : '';
  return `
    <div class="card stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      ${trendHTML}${subHTML}
    </div>
  `;
}

function renderDashboard({ summary, timeseries, categories, recent }) {
  const bestDay = summary.bestDay;
  const stats = `
    <section class="stats">
      ${statCard('Total Visitors', fmtInt(summary.totalVisitors), '30-day total')}
      ${statCard('Total Revenue', fmtMoney(summary.totalRevenue), '30-day total')}
      ${statCard(
        'Best Day',
        bestDay ? fmtInt(bestDay.visitors) : '—',
        bestDay ? fmtDate(bestDay.day) + ' visitors' : ''
      )}
      ${statCard('7-Day Trend', (summary.trendPct >= 0 ? '+' : '') + summary.trendPct.toFixed(1) + '%', null, summary.trendPct)}
    </section>
  `;

  const maxCat = categories.reduce((m, c) => Math.max(m, c.value), 0) || 1;
  const bars = categories
    .map((c) => {
      const pct = Math.max(2, (c.value / maxCat) * 100);
      return `
        <div class="bar-row">
          <div class="bar-head">
            <span class="bar-name" title="${escapeHTML(c.name)}">${escapeHTML(
        c.name
      )}</span>
            <span class="bar-value">${fmtMoney(c.value)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    })
    .join('');

  const rows = recent
    .map(
      (r) => `
      <tr>
        <td>${escapeHTML(r.name)}</td>
        <td class="cat" title="${escapeHTML(r.category)}">${escapeHTML(r.category)}</td>
        <td class="num">${fmtMoney(r.value)}</td>
        <td>${fmtDateTime(r.createdAt)}</td>
      </tr>`
    )
    .join('');

  const body = `
    <section class="body-grid">
      <div class="card chart-card">
        <h2>Visitors (30 days)</h2>
        <div class="chart-wrap" id="chart"></div>
      </div>
      <div class="card">
        <h2>Revenue by Category</h2>
        <div class="bars">${bars}</div>
      </div>
      <div class="card table-card" style="grid-column: 1 / -1;">
        <h2>Recent Items</h2>
        <div class="table-scroll">
          <table class="recent">
            <thead>
              <tr><th>Name</th><th>Category</th><th class="num">Value</th><th>Created</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  app.innerHTML = headerHTML() + stats + body;
  wireHeader();

  // draw chart
  if (chartInstance) chartInstance.destroy();
  const chartEl = document.getElementById('chart');
  chartInstance = createTimeSeriesChart(chartEl, timeseries);
}

function wireHeader() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.addEventListener('click', toggleTheme);
  applyTheme(currentTheme);
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------- bootstrap ----------------
async function init() {
  renderLoading();
  try {
    // Settings first so the theme applies before painting data.
    const settings = await fetchSettings();
    applyTheme(settings.theme === 'dark' ? 'dark' : 'light');

    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent(),
    ]);

    renderDashboard({ summary, timeseries, categories, recent });
  } catch (err) {
    console.error(err);
    renderError(err && err.message);
  }
}

init();
