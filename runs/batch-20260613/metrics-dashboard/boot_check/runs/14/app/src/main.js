import './style.css';
import { createChart } from './chart.js';

const dashboard = document.getElementById('dashboard');
const errorBanner = document.getElementById('error-banner');
const themeToggle = document.getElementById('theme-toggle');

let chart = null;

function showError(message) {
  errorBanner.hidden = false;
  errorBanner.textContent = message;
}

function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`Request to ${path} failed (${res.status})`);
  return res.json();
}

function fmtNumber(n) {
  return new Intl.NumberFormat().format(Math.round(n));
}

function fmtCurrency(n) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(n);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildSkeleton() {
  dashboard.innerHTML = `
    <section class="stat-cards" id="stat-cards"></section>
    <section class="panel chart-panel">
      <h2 class="panel-title">Visitors — last 30 days</h2>
      <div class="chart-wrap" id="chart"></div>
    </section>
    <section class="panel category-panel">
      <h2 class="panel-title">Category breakdown</h2>
      <div id="categories"></div>
    </section>
    <section class="panel table-panel">
      <h2 class="panel-title">Recent items</h2>
      <div class="table-scroll" id="recent"></div>
    </section>
  `;
}

function renderSummary(summary) {
  const cards = document.getElementById('stat-cards');
  const trendUp = summary.trendPct >= 0;
  const trendClass = trendUp ? 'up' : 'down';
  const trendArrow = trendUp ? '▲' : '▼';
  const bestDay = summary.bestDay;

  cards.innerHTML = `
    <div class="stat-card">
      <p class="stat-label">Total Visitors</p>
      <p class="stat-value">${fmtNumber(summary.totalVisitors)}</p>
      <p class="stat-sub">across 30 days</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Total Revenue</p>
      <p class="stat-value">${fmtCurrency(summary.totalRevenue)}</p>
      <p class="stat-sub">across 30 days</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Best Day</p>
      <p class="stat-value">${bestDay ? fmtNumber(bestDay.visitors) : '—'}</p>
      <p class="stat-sub">${bestDay ? fmtDate(bestDay.day) + ' visitors' : 'no data'}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">7-Day Trend</p>
      <p class="stat-value">
        <span class="trend ${trendClass}">${trendArrow} ${Math.abs(summary.trendPct).toFixed(1)}%</span>
      </p>
      <p class="stat-sub">vs prior 7 days</p>
    </div>
  `;
}

function renderCategories(categories) {
  const wrap = document.getElementById('categories');
  if (!categories || categories.length === 0) {
    wrap.innerHTML = '<p class="panel-empty">No categories available.</p>';
    return;
  }
  const max = Math.max(...categories.map((c) => c.value));
  wrap.innerHTML = categories
    .map((c) => {
      const pct = max > 0 ? (c.value / max) * 100 : 0;
      return `
        <div class="bar-row">
          <div class="bar-head">
            <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
            <span class="bar-value">${fmtNumber(c.value)}</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct.toFixed(1)}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderRecent(items) {
  const wrap = document.getElementById('recent');
  if (!items || items.length === 0) {
    wrap.innerHTML = '<p class="panel-empty">No recent items.</p>';
    return;
  }
  const rows = items
    .map(
      (it) => `
      <tr>
        <td>${escapeHtml(it.name)}</td>
        <td class="cat-cell" title="${escapeHtml(it.category)}">${escapeHtml(it.category)}</td>
        <td class="num">${fmtCurrency(it.value)}</td>
        <td>${fmtDateTime(it.createdAt)}</td>
      </tr>
    `
    )
    .join('');
  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th class="num">Value</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadDashboard() {
  buildSkeleton();
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent')
    ]);
    clearError();
    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);

    const chartContainer = document.getElementById('chart');
    chart = createChart(chartContainer, () => timeseries);
    chart.setData(timeseries);
  } catch (err) {
    console.error(err);
    dashboard.innerHTML = '';
    showError('Could not load dashboard data. Is the backend running? ' + err.message);
  }
}

// --- Theme handling ---
async function loadTheme() {
  try {
    const { theme } = await api('/api/settings');
    applyTheme(theme || 'light');
  } catch (e) {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = themeToggle.querySelector('.theme-toggle-label');
  if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  // Chart uses CSS variables, but re-render to ensure crisp colors.
  if (chart) chart.render();
}

async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  } catch (e) {
    showError('Theme saved locally but could not persist to server: ' + e.message);
  }
}

themeToggle.addEventListener('click', toggleTheme);

loadTheme();
loadDashboard();
