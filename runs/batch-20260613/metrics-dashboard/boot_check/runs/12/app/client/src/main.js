import './styles.css';
import {
  fetchSummary,
  fetchTimeseries,
  fetchCategories,
  fetchRecent,
  fetchSettings,
  saveSettings,
} from './api.js';
import { createLineChart } from './chart.js';

const app = document.getElementById('app');

let currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
let chart = null;

// ---------- Formatting helpers ----------
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
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Theme ----------
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch (e) {}
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = themeButtonLabel();
  if (chart) chart.redraw(); // chart internals depend on theme tokens
}

function themeButtonLabel() {
  return currentTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    await saveSettings(next);
  } catch (e) {
    console.error('Failed to persist theme', e);
  }
}

// ---------- Rendering ----------
function trendBadge(pct) {
  const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '▬';
  const sign = pct > 0 ? '+' : '';
  return `<span class="trend ${cls}">${arrow} ${sign}${pct.toFixed(1)}% vs prior 7 days</span>`;
}

function statCard(label, value, extra) {
  return `
    <div class="card stat">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${value}</div>
      ${extra ? `<div>${extra}</div>` : ''}
    </div>`;
}

function renderDashboard({ summary, timeseries, categories, recent }) {
  const maxCatValue = Math.max(1, ...categories.map((c) => c.value));

  app.innerHTML = `
    <div class="wrap">
      <header class="header">
        <div>
          <h1>Metrics Dashboard</h1>
          <div class="subtitle">Last 30 days · seeded analytics</div>
        </div>
        <button id="themeToggle" class="theme-toggle" type="button" aria-label="Toggle theme">
          ${themeButtonLabel()}
        </button>
      </header>

      <section class="stat-cards" aria-label="Summary statistics">
        ${statCard('Total Visitors', fmtNumber(summary.totalVisitors))}
        ${statCard('Total Revenue', fmtCurrency(summary.totalRevenue))}
        ${statCard(
          'Best Day',
          fmtCurrency(summary.bestDay.revenue),
          `<div class="label" style="margin-top:6px">${fmtDate(summary.bestDay.date)}</div>`
        )}
        ${statCard('7-Day Trend', `${summary.trendPct > 0 ? '+' : ''}${summary.trendPct.toFixed(1)}%`, trendBadge(summary.trendPct))}
      </section>

      <div class="grid" style="margin-top:16px">
        <div class="card chart-card">
          <h2>Visitors · 30 days</h2>
          <div class="chart-host" id="chartHost"></div>
        </div>

        <div class="card">
          <h2>Category Breakdown</h2>
          <div class="bars">
            ${categories
              .map((c) => {
                const pct = (c.value / maxCatValue) * 100;
                return `
                <div class="bar-row">
                  <div class="bar-head">
                    <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
                    <span class="bar-value">${fmtNumber(c.value)}</span>
                  </div>
                  <div class="bar-track">
                    <div class="bar-fill" style="width:${pct.toFixed(1)}%"></div>
                  </div>
                </div>`;
              })
              .join('')}
          </div>
        </div>

        <div class="card table-card span-2">
          <h2>Recent Items</h2>
          <div class="table-scroll">
            <table>
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
                    <td>${escapeHtml(r.category)}</td>
                    <td class="num">${fmtNumber(r.value)}</td>
                    <td>${fmtDateTime(r.createdAt)}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  const host = document.getElementById('chartHost');
  chart = createLineChart(host, timeseries);
}

function renderLoading() {
  app.innerHTML = `
    <div class="wrap">
      <header class="header">
        <div><h1>Metrics Dashboard</h1></div>
      </header>
      <div class="skeleton">Loading dashboard…</div>
    </div>`;
}

function renderError(message) {
  app.innerHTML = `
    <div class="wrap">
      <header class="header">
        <div><h1>Metrics Dashboard</h1></div>
        <button id="themeToggle" class="theme-toggle" type="button">${themeButtonLabel()}</button>
      </header>
      <div class="state error">
        <div><strong>Unable to load dashboard data.</strong></div>
        <div style="margin-top:6px">${escapeHtml(message || 'The server may be unavailable.')}</div>
        <button class="retry" id="retryBtn" type="button">Retry</button>
      </div>
    </div>`;
  const t = document.getElementById('themeToggle');
  if (t) t.addEventListener('click', toggleTheme);
  document.getElementById('retryBtn').addEventListener('click', init);
}

// ---------- Init ----------
async function init() {
  renderLoading();
  if (chart) {
    chart.destroy();
    chart = null;
  }

  // Theme: try to load persisted preference first (non-fatal if it fails).
  try {
    const settings = await fetchSettings();
    applyTheme(settings.theme === 'dark' ? 'dark' : 'light');
  } catch (e) {
    // keep cached/default theme
  }

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent(),
    ]);
    renderDashboard({ summary, timeseries, categories, recent });
  } catch (e) {
    renderError(e.message);
  }
}

init();
