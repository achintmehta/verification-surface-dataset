import './styles.css';
import { createTimeSeriesChart } from './chart.js';

const app = document.getElementById('app');
let chart = null;
let currentTheme = 'light';

// ------------------------------------------------------------------
// API helpers
// ------------------------------------------------------------------
async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------
// Formatters
// ------------------------------------------------------------------
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtNum(n) {
  return nf.format(Math.round(n));
}
function fmtMoney(n) {
  return cf.format(n);
}
function fmtDate(iso) {
  // iso may be YYYY-MM-DD or full ISO
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00Z' : iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
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

// ------------------------------------------------------------------
// Theme
// ------------------------------------------------------------------
function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  try {
    localStorage.setItem('theme-hint', currentTheme);
  } catch (e) {}
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.innerHTML =
      currentTheme === 'dark'
        ? '<span aria-hidden="true">\u2600\uFE0F</span> Light'
        : '<span aria-hidden="true">\u{1F319}</span> Dark';
  }
  if (chart) chart.redraw();
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    await getJSON('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (e) {
    // revert on failure
    applyTheme(next === 'dark' ? 'light' : 'dark');
    console.error('Failed to persist theme', e);
  }
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function renderShell() {
  app.innerHTML = `
    <div class="page">
      <header class="header">
        <div style="min-width:0">
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Seeded analytics overview</p>
        </div>
        <button id="theme-toggle" class="theme-toggle" type="button"></button>
      </header>
      <div id="content"></div>
    </div>
  `;
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
}

function renderLoading() {
  document.getElementById('content').innerHTML = `
    <div class="state">Loading dashboard\u2026</div>
  `;
}

function renderError() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="state error">
      <div>Couldn\u2019t load dashboard data.</div>
      <div style="font-size:0.85rem;margin-top:6px;">
        The backend may be offline. No cached data is shown.
      </div>
      <button class="retry" id="retry-btn" type="button">Retry</button>
    </div>
  `;
  document.getElementById('retry-btn').addEventListener('click', load);
}

function statCard(label, value, meta) {
  return `
    <div class="card">
      <p class="stat-label">${label}</p>
      <p class="stat-value" title="${value}">${value}</p>
      ${meta ? `<p class="stat-meta">${meta}</p>` : ''}
    </div>
  `;
}

function renderDashboard({ summary, timeseries, categories, recent }) {
  const trend = summary.trendPct;
  const trendClass = trend >= 0 ? 'pos' : 'neg';
  const trendArrow = trend >= 0 ? '\u25B2' : '\u25BC';
  const bestDayMeta = summary.bestDay
    ? `${fmtDate(summary.bestDay.day)} \u00B7 ${fmtNum(summary.bestDay.visitors)} visitors`
    : '\u2014';

  const maxCat = categories.reduce((m, c) => Math.max(m, c.value), 0) || 1;

  const content = document.getElementById('content');
  content.innerHTML = `
    <section class="stats" aria-label="Summary statistics">
      ${statCard('Total Visitors', fmtNum(summary.totalVisitors), 'Last 30 days')}
      ${statCard('Total Revenue', fmtMoney(summary.totalRevenue), 'Last 30 days')}
      ${statCard('Best Day', fmtNum(summary.bestDay ? summary.bestDay.visitors : 0), bestDayMeta)}
      ${statCard(
        '7-Day Trend',
        `<span class="trend ${trendClass}">${trendArrow} ${Math.abs(trend).toFixed(1)}%</span>`,
        'vs previous 7 days'
      )}
    </section>

    <section class="grid body-grid" style="margin-top:16px">
      <div class="panel">
        <h2 class="panel-title">Visitors \u2014 last 30 days</h2>
        <div class="chart-wrap" id="chart"></div>
      </div>

      <div class="panel">
        <h2 class="panel-title">Category breakdown</h2>
        <div id="cats">
          ${categories
            .map(
              (c) => `
            <div class="cat-row">
              <div class="cat-head">
                <span class="cat-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
                <span class="cat-value">${fmtNum(c.value)}</span>
              </div>
              <div class="cat-track">
                <div class="cat-fill" style="width:${Math.max(2, (c.value / maxCat) * 100)}%"></div>
              </div>
            </div>`
            )
            .join('')}
        </div>
      </div>

      <div class="panel full">
        <h2 class="panel-title">Recent items</h2>
        <div class="table-scroll">
          <table class="recent">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th class="num">Value</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              ${recent
                .map(
                  (r) => `
                <tr>
                  <td>${escapeHtml(r.name)}</td>
                  <td><span class="tag" title="${escapeHtml(r.category)}">${escapeHtml(
                    r.category
                  )}</span></td>
                  <td class="num">${fmtMoney(r.value)}</td>
                  <td>${fmtDateTime(r.createdAt)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <p class="footer">Data served from PGLite \u00B7 ${timeseries.length} days \u00B7 ${
    categories.length
  } categories \u00B7 ${recent.length} recent items</p>
  `;

  // (re)create chart
  if (chart) {
    chart.destroy();
    chart = null;
  }
  chart = createTimeSeriesChart(document.getElementById('chart'), timeseries);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
async function load() {
  renderLoading();
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      getJSON('/api/settings'),
      getJSON('/api/summary'),
      getJSON('/api/timeseries'),
      getJSON('/api/categories'),
      getJSON('/api/recent'),
    ]);
    applyTheme(settings.theme);
    renderDashboard({ summary, timeseries, categories, recent });
  } catch (e) {
    console.error(e);
    renderError();
  }
}

renderShell();
// Apply persisted theme button label from the early hint, then load authoritative.
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
load();
