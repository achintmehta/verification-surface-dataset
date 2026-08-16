import './style.css';
import { createChart } from './chart.js';

const app = document.getElementById('app');
let chart = null;

const fmtCurrency = (n) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);

const fmtNumber = (n) => new Intl.NumberFormat('en-US').format(n);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`Request to ${path} failed (${res.status})`);
  return res.json();
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.cookie = `theme=${theme}; path=/; max-age=31536000`;
  if (chart) chart.redraw();
}

function shellHTML(theme) {
  const isDark = theme === 'dark';
  return `
    <header class="app-header">
      <div>
        <h1>Metrics Dashboard</h1>
        <p class="subtitle">Seeded analytics overview</p>
      </div>
      <button class="theme-toggle" id="themeToggle" aria-label="Toggle theme">
        <span>${isDark ? '\u2600\uFE0F' : '\uD83C\uDF19'}</span>
        <span>${isDark ? 'Light' : 'Dark'} mode</span>
      </button>
    </header>
    <div id="content"></div>
    <footer class="app-footer">Data served live from the API \u00b7 PGLite + Express</footer>
  `;
}

function statCard({ label, value, meta, trend }) {
  let trendHTML = '';
  if (trend !== undefined && trend !== null) {
    const cls = trend >= 0 ? 'pos' : 'neg';
    const arrow = trend >= 0 ? '\u25B2' : '\u25BC';
    trendHTML = `<span class="trend ${cls}">${arrow} ${Math.abs(trend).toFixed(1)}%</span>`;
  }
  return `
    <div class="panel stat-card">
      <span class="label">${label}</span>
      <span class="value">${value}</span>
      <span class="meta">${meta || ''} ${trendHTML}</span>
    </div>
  `;
}

function renderError(message) {
  app.innerHTML = `
    ${shellHTML(document.documentElement.getAttribute('data-theme') || 'light')}
  `;
  document.getElementById('content').innerHTML = `
    <div class="banner-error">Unable to load dashboard data.</div>
    <div class="panel"><div class="state error">${message}</div>
    <div class="state">Make sure the backend server is running, then reload.</div></div>
  `;
  wireToggle();
}

function wireToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // Re-render shell button label.
    const labels = btn.querySelectorAll('span');
    if (labels[0]) labels[0].textContent = next === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
    if (labels[1]) labels[1].textContent = (next === 'dark' ? 'Light' : 'Dark') + ' mode';
    try {
      await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
    } catch (e) {
      console.error('Failed to persist theme', e);
    }
  });
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3.6e6);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function load() {
  // Theme first so we paint with the persisted palette.
  let theme = document.documentElement.getAttribute('data-theme') || 'light';
  try {
    const settings = await api('/api/settings');
    theme = settings.theme || 'light';
  } catch (e) {
    // settings is part of the API; if it fails the whole backend is likely down.
    renderError('Could not reach the settings API: ' + e.message);
    return;
  }
  setTheme(theme);

  app.innerHTML = shellHTML(theme);
  wireToggle();

  let summary, timeseries, categories, recent;
  try {
    [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent'),
    ]);
  } catch (e) {
    renderError('Could not load metrics: ' + e.message);
    return;
  }

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="dashboard">
      <div class="stat-cards">
        ${statCard({
          label: 'Total Visitors',
          value: fmtNumber(summary.totalVisitors),
          meta: 'last 30 days',
        })}
        ${statCard({
          label: 'Total Revenue',
          value: fmtCurrency(summary.totalRevenue),
          meta: 'last 30 days',
        })}
        ${statCard({
          label: 'Best Day',
          value: fmtNumber(summary.bestDay.visitors),
          meta: summary.bestDay.date ? `visitors \u00b7 ${summary.bestDay.date}` : 'visitors',
        })}
        ${statCard({
          label: '7-Day Trend',
          value: `${summary.trend7d >= 0 ? '+' : ''}${summary.trend7d.toFixed(1)}%`,
          meta: 'revenue vs prior 7d',
          trend: summary.trend7d,
        })}
      </div>

      <div class="body-grid">
        <section class="panel">
          <h2>Revenue \u2014 last 30 days</h2>
          <div class="chart-wrap" id="chart"></div>
          <div class="chart-legend">
            <span><span class="swatch" style="background:var(--chart-line)"></span>Daily revenue (USD)</span>
          </div>
        </section>

        <section class="panel">
          <h2>Revenue by Category</h2>
          <div class="bar-list" id="bars"></div>
        </section>
      </div>

      <section class="panel">
        <h2>Recent Items</h2>
        <div class="table-scroll">
          <table class="recent">
            <thead>
              <tr><th>Name</th><th>Category</th><th class="num">Value</th><th>When</th></tr>
            </thead>
            <tbody id="recentBody"></tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  // Category bars
  const bars = document.getElementById('bars');
  const maxCat = Math.max(...categories.map((c) => c.value), 1);
  bars.innerHTML = categories
    .map((c) => {
      const pct = Math.max(2, (c.value / maxCat) * 100);
      return `
        <div class="bar-row">
          <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
          <span class="bar-value">${fmtCurrency(c.value)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    })
    .join('');

  // Recent table
  const tbody = document.getElementById('recentBody');
  tbody.innerHTML = recent
    .map(
      (r) => `
      <tr>
        <td class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
        <td class="name" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</td>
        <td class="num">${fmtCurrency(r.value)}</td>
        <td>${timeAgo(r.createdAt)}</td>
      </tr>`
    )
    .join('');

  // Chart
  const chartEl = document.getElementById('chart');
  if (chart) chart.destroy();
  chart = createChart(chartEl, timeseries);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

load();
