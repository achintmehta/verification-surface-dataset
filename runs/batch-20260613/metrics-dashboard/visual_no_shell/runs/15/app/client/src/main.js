import './styles.css';
import { createLineChart } from './chart.js';

const app = document.getElementById('app');
let chart = null;

const fmtInt = new Intl.NumberFormat('en-US');
const fmtMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const fmtMoney2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${url}`);
  return res.json();
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

async function persistTheme(theme) {
  try {
    await fetchJSON('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
  } catch (e) {
    // Revert visual change on persistence failure is overkill; keep UX simple.
    console.error('Failed to persist theme', e);
  }
}

function renderLoading() {
  app.innerHTML = `
    <div class="page">
      <header class="header">
        <div>
          <h1>Metrics Dashboard</h1>
          <div class="subtitle">Loading…</div>
        </div>
      </header>
      <div class="state skeleton">Loading dashboard…</div>
    </div>`;
}

function renderError(message) {
  app.innerHTML = `
    <div class="page">
      <header class="header">
        <div>
          <h1>Metrics Dashboard</h1>
          <div class="subtitle">Connection problem</div>
        </div>
      </header>
      <div class="card">
        <div class="state error">
          <div class="state-title">Unable to load data</div>
          <div>${message || 'The dashboard could not reach the metrics API.'}</div>
          <button class="retry-btn" id="retry">Retry</button>
        </div>
      </div>
    </div>`;
  const btn = document.getElementById('retry');
  if (btn) btn.addEventListener('click', load);
}

function trendMarkup(trend) {
  const positive = trend >= 0;
  const arrow = positive ? '▲' : '▼';
  const cls = positive ? 'pos' : 'neg';
  const sign = positive ? '+' : '';
  return `<span class="trend ${cls}">${arrow} ${sign}${trend.toFixed(1)}%</span>`;
}

function statCard(label, value, sub) {
  return `
    <div class="card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${sub || '&nbsp;'}</div>
    </div>`;
}

function renderDashboard({ summary, timeseries, categories, recent }) {
  const best = summary.bestDay;
  const bestStr = best
    ? `${fmtInt.format(best.visitors)} on ${best.day.slice(5)}`
    : '—';

  const maxCat = categories.length ? Math.max(...categories.map((c) => c.value)) : 1;

  const catRows = categories
    .map((c) => {
      const pct = maxCat > 0 ? (c.value / maxCat) * 100 : 0;
      return `
        <div class="bar-row">
          <div class="bar-head">
            <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
            <span class="bar-value">${fmtMoney.format(c.value)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        </div>`;
    })
    .join('');

  const recentRows = recent
    .map((r) => {
      const d = new Date(r.createdAt);
      const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td><span class="cat-pill" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</span></td>
          <td class="num">${fmtMoney2.format(r.value)}</td>
          <td>${date}</td>
        </tr>`;
    })
    .join('');

  const theme = currentTheme();

  app.innerHTML = `
    <div class="page">
      <header class="header">
        <div>
          <h1>Metrics Dashboard</h1>
          <div class="subtitle">Last 30 days · seeded analytics</div>
        </div>
        <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
          <span id="theme-icon">${theme === 'dark' ? '☀️' : '🌙'}</span>
          <span id="theme-text">${theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
      </header>

      <section class="stats">
        ${statCard('Total Visitors', fmtInt.format(summary.totalVisitors), '30-day total')}
        ${statCard('Total Revenue', fmtMoney.format(summary.totalRevenue), '30-day total')}
        ${statCard('Best Day', best ? fmtInt.format(best.visitors) : '—', best ? `visitors · ${best.day.slice(5)}` : 'no data')}
        ${statCard('7-Day Trend', trendMarkup(summary.trend7d), 'vs previous 7 days')}
      </section>

      <section class="body-grid">
        <div class="card chart-card">
          <h2>Visitors — Last 30 Days</h2>
          <div class="chart-wrap" id="chart"></div>
        </div>
        <div class="card">
          <h2>Revenue by Category</h2>
          <div class="bars">${catRows || '<div class="state">No categories</div>'}</div>
        </div>
        <div class="card span-2">
          <h2>Recent Items</h2>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th class="num">Value</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>${recentRows}</tbody>
            </table>
          </div>
        </div>
      </section>
    </div>`;

  const chartEl = document.getElementById('chart');
  if (chart) chart.destroy();
  chart = createLineChart(chartEl, timeseries);

  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', async () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.getElementById('theme-icon').textContent = next === 'dark' ? '☀️' : '🌙';
    document.getElementById('theme-text').textContent = next === 'dark' ? 'Light' : 'Dark';
    // Chart uses CSS vars; nudge a redraw so any cached colors update.
    if (chart) chart.update(timeseries);
    await persistTheme(next);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function load() {
  renderLoading();
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/api/summary'),
      fetchJSON('/api/timeseries'),
      fetchJSON('/api/categories'),
      fetchJSON('/api/recent'),
    ]);
    renderDashboard({ summary, timeseries, categories, recent });
  } catch (err) {
    console.error(err);
    renderError(err.message);
  }
}

load();
