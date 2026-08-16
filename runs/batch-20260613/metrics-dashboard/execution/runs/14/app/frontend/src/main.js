import './styles.css';
import { LineChart } from './chart.js';

const API = '/api';

const fmtInt = new Intl.NumberFormat('en-US');
const fmtMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const fmtMoneyCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

let chart = null;

async function getJSON(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(`Request to ${path} failed: ${res.status}`);
  return res.json();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch (e) {}
  if (chart) chart.render();
}

function formatDateLong(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00Z' : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
}

function renderShell(theme) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="header">
      <div>
        <h1>Metrics Dashboard</h1>
        <p class="subtitle">Last 30 days overview</p>
      </div>
      <button class="theme-toggle" id="theme-toggle" aria-label="Toggle color theme">
        <span id="theme-icon">${theme === 'dark' ? '☀️' : '🌙'}</span>
        <span id="theme-label">${theme === 'dark' ? 'Light' : 'Dark'} mode</span>
      </button>
    </header>
    <main class="dashboard" id="dashboard">
      <div class="state" id="loading">Loading dashboard…</div>
    </main>
  `;

  document.getElementById('theme-toggle').addEventListener('click', onToggleTheme);
}

async function onToggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (icon) icon.textContent = next === 'dark' ? '☀️' : '🌙';
  if (label) label.textContent = (next === 'dark' ? 'Light' : 'Dark') + ' mode';
  try {
    await getJSON('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (e) {
    console.warn('Could not persist theme', e);
  }
}

function statCard(label, value, sub) {
  return `
    <div class="card">
      <p class="stat-label">${label}</p>
      <p class="stat-value">${value}</p>
      <p class="stat-sub">${sub}</p>
    </div>`;
}

function renderDashboard(data) {
  const { summary, timeseries, categories, recent } = data;
  const dash = document.getElementById('dashboard');

  const trendClass = summary.trendPct >= 0 ? 'up' : 'down';
  const trendArrow = summary.trendPct >= 0 ? '▲' : '▼';
  const trendSub = `<span class="trend ${trendClass}">${trendArrow} ${Math.abs(summary.trendPct).toFixed(1)}%</span> vs prior 7 days`;

  const statsHtml = `
    <section class="stats">
      ${statCard('Total Visitors', fmtInt.format(summary.totalVisitors), '30-day total')}
      ${statCard('Total Revenue', fmtMoney.format(summary.totalRevenue), '30-day total')}
      ${statCard('Best Day', fmtInt.format(summary.bestDay.visitors), formatDateLong(summary.bestDay.day) + ' · visitors')}
      ${statCard('7-Day Trend', `<span class="trend ${trendClass}">${trendArrow} ${Math.abs(summary.trendPct).toFixed(1)}%</span>`, trendSub)}
    </section>`;

  const maxCat = Math.max(...categories.map((c) => Number(c.value)), 1);
  const barsHtml = categories.map((c) => {
    const pct = (Number(c.value) / maxCat) * 100;
    return `
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
          <span class="bar-value">${fmtInt.format(Number(c.value))}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');

  const rowsHtml = recent.map((r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td><span class="cat-cell" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</span></td>
      <td class="num">${fmtMoneyCents.format(Number(r.value))}</td>
      <td class="num">${formatDateTime(r.created_at)}</td>
    </tr>`).join('');

  dash.innerHTML = `
    ${statsHtml}
    <section class="body-grid">
      <div class="card chart-wrap">
        <h2>Visitors — last 30 days</h2>
        <div class="chart-host" id="chart-host"></div>
      </div>
      <div class="card">
        <h2>Traffic by category</h2>
        <div class="bars">${barsHtml}</div>
      </div>
    </section>
    <section class="card">
      <h2>Recent items</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th class="num">Value</th>
              <th class="num">Created</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </section>
  `;

  const host = document.getElementById('chart-host');
  if (chart) chart.destroy();
  chart = new LineChart(host);
  chart.setData(timeseries);
}

function renderError(message) {
  const dash = document.getElementById('dashboard');
  if (chart) {
    chart.destroy();
    chart = null;
  }
  dash.innerHTML = `
    <div class="state error">
      <p><strong>Unable to load dashboard data.</strong></p>
      <p>${escapeHtml(message)}</p>
      <p class="muted">The dashboard renders entirely from the API. Make sure the backend server is running.</p>
      <button id="retry">Retry</button>
    </div>`;
  document.getElementById('retry').addEventListener('click', loadData);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadData() {
  const dash = document.getElementById('dashboard');
  dash.innerHTML = `<div class="state">Loading dashboard…</div>`;
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      getJSON('/summary'),
      getJSON('/timeseries'),
      getJSON('/categories'),
      getJSON('/recent'),
    ]);
    renderDashboard({ summary, timeseries, categories, recent });
  } catch (err) {
    renderError(err.message || 'Network error');
  }
}

async function init() {
  // Load persisted theme (server-side) before rendering content.
  let theme = document.documentElement.getAttribute('data-theme') || 'light';
  try {
    const settings = await getJSON('/settings');
    if (settings.theme === 'light' || settings.theme === 'dark') {
      theme = settings.theme;
    }
  } catch (e) {
    // fall back to cached/default theme
  }
  applyTheme(theme);
  renderShell(theme);
  await loadData();
}

init();
