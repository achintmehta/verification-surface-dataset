import './styles.css';
import { createChart } from './chart.js';

const app = document.getElementById('app');

// --- API helpers ------------------------------------------------------------
async function api(path, options) {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    throw new Error(`Request to ${path} failed: ${res.status}`);
  }
  return res.json();
}

// --- Formatting -------------------------------------------------------------
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtNum(n) {
  return nf.format(n);
}
function fmtCurrency(n) {
  return cf.format(n);
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

// --- Theme ------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

let chart = null;

// --- Rendering --------------------------------------------------------------
function renderSkeleton() {
  app.setAttribute('aria-busy', 'true');
  app.innerHTML = `<div class="skeleton">Loading dashboard…</div>`;
}

function renderError(retry) {
  app.removeAttribute('aria-busy');
  app.innerHTML = `
    <div class="state state--error" role="alert">
      <p class="state__title">Couldn’t load the dashboard</p>
      <p class="state__msg">The metrics API didn’t respond. Make sure the
        backend server is running, then try again.</p>
      <button class="retry-btn" id="retry">Retry</button>
    </div>`;
  document.getElementById('retry').addEventListener('click', retry);
}

function trendMarkup(pct) {
  const up = pct >= 0;
  const arrow = up ? '▲' : '▼';
  const cls = up ? 'trend--up' : 'trend--down';
  return `<span class="trend ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function statCard({ label, value, meta }) {
  return `
    <div class="card">
      <p class="stat__label">${label}</p>
      <p class="stat__value">${value}</p>
      <p class="stat__meta">${meta}</p>
    </div>`;
}

function renderDashboard(data) {
  const { summary, timeseries, categories, recent, theme } = data;

  app.removeAttribute('aria-busy');
  app.innerHTML = `
    <header class="header">
      <div>
        <h1 class="header__title">Metrics Dashboard</h1>
        <p class="header__subtitle">Last 30 days · seeded sample data</p>
      </div>
      <button class="theme-toggle" id="theme-toggle" aria-label="Toggle color theme">
        <span id="theme-icon">${theme === 'dark' ? '☀️' : '🌙'}</span>
        <span id="theme-text">${theme === 'dark' ? 'Light' : 'Dark'}</span>
      </button>
    </header>

    <div class="dashboard">
      <section class="stats" aria-label="Summary statistics">
        ${statCard({
          label: 'Total Visitors',
          value: fmtNum(summary.totalVisitors),
          meta: '30-day total',
        })}
        ${statCard({
          label: 'Total Revenue',
          value: fmtCurrency(summary.totalRevenue),
          meta: '30-day total',
        })}
        ${statCard({
          label: 'Best Day',
          value: summary.bestDay ? fmtNum(summary.bestDay.visitors) : '—',
          meta: summary.bestDay ? fmtDate(summary.bestDay.date) : 'No data',
        })}
        ${statCard({
          label: '7-Day Trend',
          value: trendMarkup(summary.trendPct),
          meta: 'vs. previous 7 days',
        })}
      </section>

      <section class="body-grid">
        <div class="card">
          <h2 class="card__title">Visitors (30 days)</h2>
          <div class="chart-wrap" id="chart"></div>
        </div>

        <div class="card">
          <h2 class="card__title">Category Breakdown</h2>
          <div class="bars" id="bars"></div>
        </div>

        <div class="card card--table">
          <h2 class="card__title">Recent Items</h2>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th class="td-num">Value</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody id="recent-body"></tbody>
            </table>
          </div>
        </div>
      </section>
    </div>`;

  // Chart
  if (chart) chart.destroy();
  chart = createChart(document.getElementById('chart'));
  chart.setData(timeseries);

  // Category bars
  renderBars(categories);

  // Recent table
  renderRecent(recent);

  // Theme toggle
  document
    .getElementById('theme-toggle')
    .addEventListener('click', () => toggleTheme(data));
}

function renderBars(categories) {
  const bars = document.getElementById('bars');
  const max = Math.max(1, ...categories.map((c) => c.value));
  bars.innerHTML = categories
    .map((c) => {
      const pct = (c.value / max) * 100;
      const safeName = escapeHtml(c.name);
      return `
        <div class="bar-row">
          <span class="bar-row__label" title="${safeName}">${safeName}</span>
          <span class="bar-row__value">${fmtNum(c.value)}</span>
          <span class="bar-row__track">
            <span class="bar-row__fill" style="width:${pct}%"></span>
          </span>
        </div>`;
    })
    .join('');
}

function renderRecent(recent) {
  const body = document.getElementById('recent-body');
  body.innerHTML = recent
    .map(
      (r) => `
        <tr>
          <td class="td-name">${escapeHtml(r.name)}</td>
          <td><span class="pill" title="${escapeHtml(r.category)}">${escapeHtml(
        r.category
      )}</span></td>
          <td class="td-num">${fmtNum(r.value)}</td>
          <td>${fmtDateTime(r.createdAt)}</td>
        </tr>`
    )
    .join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Theme toggle round-trips through the API -------------------------------
async function toggleTheme(data) {
  const next = data.theme === 'dark' ? 'light' : 'dark';
  data.theme = next;
  applyTheme(next); // optimistic, immediate restyle (chart redraws via CSS vars)
  // Update toggle button label/icon without a full re-render.
  const icon = document.getElementById('theme-icon');
  const text = document.getElementById('theme-text');
  if (icon) icon.textContent = next === 'dark' ? '☀️' : '🌙';
  if (text) text.textContent = next === 'dark' ? 'Light' : 'Dark';
  try {
    await api('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    // If persistence fails, keep the optimistic UI but log.
    console.error('Failed to persist theme', err);
  }
}

// --- Boot -------------------------------------------------------------------
async function load() {
  renderSkeleton();
  try {
    // Apply the persisted theme first so we don't flash the wrong palette.
    const settings = await api('/settings');
    applyTheme(settings.theme);

    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/summary'),
      api('/timeseries'),
      api('/categories'),
      api('/recent'),
    ]);

    renderDashboard({
      summary,
      timeseries,
      categories,
      recent,
      theme: settings.theme,
    });
  } catch (err) {
    console.error(err);
    renderError(load);
  }
}

load();
