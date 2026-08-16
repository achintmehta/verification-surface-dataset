import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

const nf = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const shortMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

let state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: document.documentElement.dataset.theme || 'light',
  error: null,
};
let chartResizeObserver;

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  try { sessionStorage.setItem('dashboard-theme', state.theme); } catch (e) {}
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = state.theme;
  drawChart();
}

async function fetchJson(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function loadDashboard() {
  renderShell(true);
  try {
    const settings = await fetchJson('/api/settings');
    setTheme(settings.theme);
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/api/summary'),
      fetchJson('/api/timeseries'),
      fetchJson('/api/categories'),
      fetchJson('/api/recent'),
    ]);
    state = { ...state, summary, timeseries, categories, recent, error: null };
    renderShell(false);
  } catch (error) {
    console.error(error);
    state.error = 'Unable to load dashboard data. Start the backend API and refresh the page.';
    state.summary = null;
    state.timeseries = [];
    state.categories = [];
    state.recent = [];
    renderShell(false);
  }
}

function renderShell(loading = false) {
  app.innerHTML = `
    <div class="dashboard">
      <header class="site-header">
        <div class="title-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" type="button" aria-label="Toggle dark theme" aria-pressed="${state.theme === 'dark'}">
          <span class="toggle-icon">${state.theme === 'dark' ? '☾' : '☀'}</span>
          <span>${state.theme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
      </header>
      ${loading ? loadingMarkup() : state.error ? errorMarkup(state.error) : dashboardMarkup()}
    </div>
  `;

  app.querySelector('.theme-toggle')?.addEventListener('click', toggleTheme);
  if (!loading && !state.error) {
    drawChart();
    attachResizeObserver();
  }
}

function loadingMarkup() {
  return `<main class="empty-card"><h2>Loading dashboard…</h2><p>Fetching metrics from the PGLite-backed API.</p></main>`;
}

function errorMarkup(message) {
  return `<main class="empty-card error-state"><h2>Dashboard unavailable</h2><p>${escapeHtml(message)}</p><button class="retry" type="button">Retry</button></main>`;
}

function dashboardMarkup() {
  return `
    <main>
      <section class="stats-grid" aria-label="Summary metrics">
        ${statCard('Total Visitors', nf.format(state.summary.totalVisitors), `${trendText(state.summary.sevenDayTrend)} vs prior 7 days`, state.summary.sevenDayTrend >= 0)}
        ${statCard('Total Revenue', money.format(state.summary.totalRevenue), '30-day generated revenue', true)}
        ${statCard('Best Day', formatShortDate(state.summary.bestDay.date), `${nf.format(state.summary.bestDay.visitors)} visitors`, true)}
        ${statCard('Largest Category', nf.format(state.summary.largestCategoryValue), 'Seeded 7-digit value check', true, 'wide-number')}
      </section>

      <section class="body-grid">
        <article class="panel chart-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">30 days</p><h2>Visitor trend</h2></div>
            <span class="panel-note">SVG redraws on resize</span>
          </div>
          <div class="chart-wrap" id="timeseries-chart" role="img" aria-label="Line chart of visitors over the last 30 days"></div>
        </article>

        <article class="panel categories-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">Breakdown</p><h2>Categories</h2></div>
          </div>
          <div class="bars" aria-label="Category values">
            ${state.categories.map(categoryBar).join('')}
          </div>
        </article>
      </section>

      <section class="panel table-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Latest 20</p><h2>Recent items</h2></div>
        </div>
        ${recentTable()}
      </section>
    </main>
  `;
}

function statCard(label, value, detail, positive, extraClass = '') {
  return `
    <article class="stat-card ${extraClass}">
      <p>${label}</p>
      <strong title="${escapeHtml(String(value))}">${value}</strong>
      <span class="trend ${positive ? 'positive' : 'negative'}">${positive ? '▲' : '▼'} ${detail}</span>
    </article>
  `;
}

function categoryBar(c) {
  const max = Math.max(...state.categories.map((x) => x.value));
  const pct = Math.max(4, (c.value / max) * 100);
  return `
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
        <strong>${nf.format(c.value)}</strong>
      </div>
      <div class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></div>
    </div>
  `;
}

function recentTable() {
  return `
    <div class="table-scroller">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
        <tbody>
          ${state.recent.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-strong">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${money.format(item.value)}</td>
              <td data-label="Created">${formatShortDate(item.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  renderShell(false);
  try {
    const saved = await fetchJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: next }),
    });
    setTheme(saved.theme);
    const button = app.querySelector('.theme-toggle');
    if (button) {
      button.setAttribute('aria-pressed', String(saved.theme === 'dark'));
      button.innerHTML = `<span class="toggle-icon">${saved.theme === 'dark' ? '☾' : '☀'}</span><span>${saved.theme === 'dark' ? 'Dark' : 'Light'}</span>`;
    }
  } catch (error) {
    console.error(error);
  }
}

function attachResizeObserver() {
  if (chartResizeObserver) chartResizeObserver.disconnect();
  const chart = document.querySelector('#timeseries-chart');
  if (!chart) return;
  chartResizeObserver = new ResizeObserver(() => drawChart());
  chartResizeObserver.observe(chart);
}

function drawChart() {
  const el = document.querySelector('#timeseries-chart');
  if (!el || !state.timeseries.length) return;

  const width = Math.max(280, Math.floor(el.clientWidth));
  const height = Math.max(250, Math.floor(el.clientHeight || 300));
  const isNarrow = width < 420;
  const margin = { top: 18, right: isNarrow ? 24 : 18, bottom: isNarrow ? 48 : 42, left: isNarrow ? 46 : 60 };
  const innerW = Math.max(1, width - margin.left - margin.right);
  const innerH = Math.max(1, height - margin.top - margin.bottom);
  const values = state.timeseries.map((d) => d.visitors);
  const min = Math.floor(Math.min(...values) / 250) * 250;
  const max = Math.ceil(Math.max(...values) / 250) * 250;
  const yRange = max - min || 1;
  const x = (i) => margin.left + (i / (state.timeseries.length - 1)) * innerW;
  const y = (v) => margin.top + innerH - ((v - min) / yRange) * innerH;
  const path = state.timeseries.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ');
  const yTicks = Array.from({ length: 5 }, (_, i) => min + (yRange / 4) * i);
  const xTickIdx = isNarrow ? [0, 14, 29] : [0, 7, 14, 21, 29];

  const styles = getComputedStyle(document.documentElement);
  const grid = styles.getPropertyValue('--chart-grid').trim();
  const axis = styles.getPropertyValue('--chart-axis').trim();
  const text = styles.getPropertyValue('--muted').trim();
  const line = styles.getPropertyValue('--accent').trim();
  const fill = styles.getPropertyValue('--accent-soft').trim();

  const areaPath = `${path} L ${x(state.timeseries.length - 1).toFixed(2)} ${margin.top + innerH} L ${margin.left} ${margin.top + innerH} Z`;

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      ${yTicks.map((tick) => {
        const ty = y(tick);
        return `<line x1="${margin.left}" y1="${ty}" x2="${width - margin.right}" y2="${ty}" stroke="${grid}" stroke-width="1" />
          <text x="${margin.left - 8}" y="${ty + 4}" text-anchor="end" fill="${text}" font-size="11">${nf.format(Math.round(tick))}</text>`;
      }).join('')}
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="${axis}" stroke-width="1" />
      <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="${axis}" stroke-width="1" />
      <path d="${areaPath}" fill="${fill}" opacity="0.45"></path>
      <path d="${path}" fill="none" stroke="${line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      ${state.timeseries.map((d, i) => i % (isNarrow ? 7 : 5) === 0 || i === state.timeseries.length - 1 ? `<circle cx="${x(i)}" cy="${y(d.visitors)}" r="3" fill="${line}" />` : '').join('')}
      ${xTickIdx.map((idx) => {
        const tx = x(idx);
        const label = formatTinyDate(state.timeseries[idx].date);
        const anchor = idx === 0 ? 'start' : idx === state.timeseries.length - 1 ? 'end' : 'middle';
        return `<line x1="${tx}" y1="${height - margin.bottom}" x2="${tx}" y2="${height - margin.bottom + 5}" stroke="${axis}" />
          <text x="${tx}" y="${height - margin.bottom + 20}" text-anchor="${anchor}" fill="${text}" font-size="11">${label}</text>`;
      }).join('')}
    </svg>
  `;
}

function trendText(value) {
  return `${Math.abs(value).toFixed(1)}%`;
}

function parseDisplayDate(value) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0);
  }
  return new Date(value);
}

function formatShortDate(value) {
  const date = parseDisplayDate(value);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

function formatTinyDate(value) {
  const date = parseDisplayDate(value);
  return new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric' }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

app.addEventListener('click', (event) => {
  if (event.target.closest('.retry')) loadDashboard();
});

loadDashboard();
