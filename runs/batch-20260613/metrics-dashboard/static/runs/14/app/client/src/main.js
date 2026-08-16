import './style.css';
import { api } from './api.js';
import { createChart } from './chart.js';

const app = document.getElementById('app');

const numberFmt = new Intl.NumberFormat('en-US');
const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtDate(iso) {
  // iso may be YYYY-MM-DD or full ISO timestamp
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let chart = null;
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch (e) {
    /* ignore */
  }
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  }
  // The chart pulls colors from CSS vars, so redraw to recolor internals.
  if (chart) chart.redraw();
}

function shell() {
  app.innerHTML = `
    <div class="wrap">
      <header class="app-header">
        <div>
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Seeded analytics overview · last 30 days</p>
        </div>
        <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle theme">🌙 Dark</button>
      </header>
      <div id="content">
        <p class="skeleton">Loading dashboard…</p>
      </div>
    </div>
  `;
  document.getElementById('themeToggle').addEventListener('click', async () => {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      await api.saveSettings(next);
    } catch (e) {
      // Theme still applies locally; persistence failed.
      console.error('Failed to persist theme', e);
    }
  });
}

function renderError(message) {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="banner" role="alert">
      <h2>Unable to load dashboard</h2>
      <p>The dashboard could not reach the metrics API. Make sure the backend
      server is running, then reload. (${escapeHtml(message)})</p>
    </div>
  `;
}

function statCard(label, value, sub) {
  return `
    <div class="card">
      <p class="stat-label">${escapeHtml(label)}</p>
      <p class="stat-value">${value}</p>
      <p class="stat-sub">${sub}</p>
    </div>
  `;
}

function renderDashboard({ summary, timeseries, categories, recent }) {
  const content = document.getElementById('content');

  const trend = summary.trendPct;
  const trendClass = trend >= 0 ? 'pos' : 'neg';
  const trendArrow = trend >= 0 ? '▲' : '▼';
  const trendStr = `<span class="trend ${trendClass}">${trendArrow} ${Math.abs(
    trend
  )}%</span>`;

  const bestDay = summary.bestDay;

  content.innerHTML = `
    <section class="stats" aria-label="Summary statistics">
      ${statCard(
        'Total Visitors',
        numberFmt.format(summary.totalVisitors),
        '30-day total'
      )}
      ${statCard(
        'Total Revenue',
        currencyFmt.format(summary.totalRevenue),
        '30-day total'
      )}
      ${statCard(
        'Best Day',
        bestDay ? numberFmt.format(bestDay.visitors) : '—',
        bestDay ? `${fmtDate(bestDay.date)} · visitors` : 'no data'
      )}
      ${statCard('7-Day Trend', trendStr, 'vs previous 7 days')}
    </section>

    <section class="body-grid">
      <div class="card chart-card">
        <h2>Visitors — last 30 days</h2>
        <div class="chart-host" id="chartHost"></div>
      </div>

      <div class="card">
        <h2>Category breakdown</h2>
        <div class="bars">
          ${renderBars(categories)}
        </div>
      </div>
    </section>

    <section class="grid" style="margin-top: var(--gap)">
      <div class="card table-card">
        <h2>Recent items</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th class="num">Value</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              ${recent
                .map(
                  (r) => `
                <tr>
                  <td class="name">${escapeHtml(r.name)}</td>
                  <td><span class="pill">${escapeHtml(r.category)}</span></td>
                  <td class="num">${currencyFmt.format(r.value)}</td>
                  <td>${fmtDateTime(r.createdAt)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  const host = document.getElementById('chartHost');
  if (chart) chart.destroy();
  chart = createChart(host);
  chart.update(timeseries);
}

function renderBars(categories) {
  const max = Math.max(...categories.map((c) => c.value), 1);
  return categories
    .map((c) => {
      const pct = Math.max(2, Math.round((c.value / max) * 100));
      return `
        <div class="bar-row">
          <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(
        c.name
      )}</span>
          <span class="bar-value">${numberFmt.format(c.value)}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

async function load() {
  // Theme first so it is applied before content paints.
  try {
    const settings = await api.settings();
    applyTheme(settings.theme === 'dark' ? 'dark' : 'light');
  } catch (e) {
    // Keep whatever the pre-paint script set; still try to render data.
    applyTheme(currentTheme);
  }

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api.summary(),
      api.timeseries(),
      api.categories(),
      api.recent(),
    ]);
    renderDashboard({ summary, timeseries, categories, recent });
  } catch (e) {
    renderError(e.message);
  }
}

shell();
load();
