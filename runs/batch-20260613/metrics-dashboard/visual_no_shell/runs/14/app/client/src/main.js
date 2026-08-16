import './styles.css';
import { api } from './api.js';
import { createChart } from './chart.js';

const app = document.getElementById('app');

const fmtInt = new Intl.NumberFormat('en-US');
const fmtMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

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

let chart = null;
let currentTheme = 'light';

function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch (e) {}
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  }
  // The chart reads CSS vars; redraw so its internals pick up new colors.
  if (chart) chart.redraw();
}

function renderShell() {
  app.innerHTML = `
    <div class="page">
      <header class="header">
        <div>
          <h1>Metrics Dashboard</h1>
          <div class="subtitle">Last 30 days &middot; seeded analytics</div>
        </div>
        <button class="theme-toggle" id="themeBtn" type="button" aria-label="Toggle theme">
          Dark mode
        </button>
      </header>

      <div id="banner-slot"></div>

      <section class="stats" id="stats" aria-label="Summary statistics">
        <div class="loading">Loading\u2026</div>
      </section>

      <section class="body-grid">
        <div class="card chart-card">
          <h2>Visitors &mdash; 30 day trend</h2>
          <div class="chart-wrap" id="chart"></div>
        </div>
        <div class="card">
          <h2>Category breakdown</h2>
          <div class="cat-list" id="categories">
            <div class="empty">Loading\u2026</div>
          </div>
        </div>
        <div class="card recent-card">
          <h2>Recent items</h2>
          <div class="table-scroll">
            <table class="recent" id="recent">
              <tbody><tr><td class="empty">Loading\u2026</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  `;

  document.getElementById('themeBtn').addEventListener('click', async () => {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      await api.saveSettings(next);
    } catch (e) {
      console.error('Could not persist theme', e);
    }
  });

  chart = createChart(document.getElementById('chart'));
}

function showBanner(message) {
  const slot = document.getElementById('banner-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="banner">
      <strong>Cannot load data.</strong>
      ${message} The dashboard renders only from the live API &mdash;
      please ensure the backend server is running, then reload.
    </div>`;
}

function renderStats(s) {
  const stats = document.getElementById('stats');
  const trendPos = s.trendPct >= 0;
  const bestDayLabel = s.bestDay
    ? `${fmtDate(s.bestDay.day)} \u00B7 ${fmtInt.format(s.bestDay.visitors)} visitors`
    : '\u2014';

  const cards = [
    {
      label: 'Total Visitors',
      value: fmtInt.format(s.totalVisitors),
      sub: 'across 30 days',
    },
    {
      label: 'Total Revenue',
      value: fmtMoney.format(s.totalRevenue),
      sub: 'across 30 days',
    },
    {
      label: 'Best Day',
      value: s.bestDay ? fmtInt.format(s.bestDay.visitors) : '\u2014',
      sub: bestDayLabel,
    },
    {
      label: '7-Day Trend',
      value: `${trendPos ? '+' : ''}${s.trendPct}%`,
      subHtml: `<span class="trend ${trendPos ? 'pos' : 'neg'}">${
        trendPos ? '\u25B2' : '\u25BC'
      } vs prior 7 days</span>`,
    },
  ];

  stats.innerHTML = cards
    .map(
      (c) => `
      <div class="card stat">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.subHtml || c.sub}</div>
      </div>`
    )
    .join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderCategories(cats) {
  const root = document.getElementById('categories');
  if (!cats.length) {
    root.innerHTML = '<div class="empty">No categories</div>';
    return;
  }
  const max = Math.max(...cats.map((c) => c.value));
  root.innerHTML = cats
    .map((c) => {
      const pct = max > 0 ? Math.max(2, (c.value / max) * 100) : 0;
      return `
        <div class="cat-row">
          <div class="cat-head">
            <span class="cat-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
            <span class="cat-value">${fmtInt.format(c.value)}</span>
          </div>
          <div class="cat-track">
            <div class="cat-fill" style="width:${pct}%"></div>
          </div>
        </div>`;
    })
    .join('');
}

function renderRecent(items) {
  const table = document.getElementById('recent');
  if (!items.length) {
    table.innerHTML =
      '<tbody><tr><td class="empty">No recent items</td></tr></tbody>';
    return;
  }
  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th>
        <th>Category</th>
        <th style="text-align:right">Value</th>
        <th>When</th>
      </tr>
    </thead>
    <tbody>
      ${items
        .map(
          (it) => `
        <tr>
          <td class="name">${escapeHtml(it.name)}</td>
          <td><span class="cat-pill" title="${escapeHtml(it.category)}">${escapeHtml(
            it.category
          )}</span></td>
          <td class="num">${fmtMoney.format(it.value)}</td>
          <td>${fmtDateTime(it.createdAt)}</td>
        </tr>`
        )
        .join('')}
    </tbody>`;
}

async function loadData() {
  // Theme settings first so we can apply before first paint of data.
  try {
    const settings = await api.settings();
    setTheme(settings.theme === 'dark' ? 'dark' : 'light');
  } catch (e) {
    // Keep whatever was cached locally; data fetch will surface the error.
    setTheme(currentTheme);
  }

  try {
    const [summary, ts, cats, recent] = await Promise.all([
      api.summary(),
      api.timeseries(),
      api.categories(),
      api.recent(),
    ]);
    renderStats(summary);
    chart.setData(ts);
    renderCategories(cats);
    renderRecent(recent);
  } catch (e) {
    console.error(e);
    showBanner(escapeHtml(e.message) + '.');
    // Replace loading placeholders with explicit empty states.
    const stats = document.getElementById('stats');
    if (stats) stats.innerHTML = '<div class="empty">No data available.</div>';
    if (chart) chart.setData([]);
    const cats = document.getElementById('categories');
    if (cats) cats.innerHTML = '<div class="empty">No data available.</div>';
    const recent = document.getElementById('recent');
    if (recent)
      recent.innerHTML =
        '<tbody><tr><td class="empty">No data available.</td></tr></tbody>';
  }
}

renderShell();
loadData();
