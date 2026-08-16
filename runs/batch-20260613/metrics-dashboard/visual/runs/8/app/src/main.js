import './styles.css';

const app = document.querySelector('#app');
const api = (path) => `/api${path}`;

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  error: null,
  chartResizeObserver: null
};

const formatInt = new Intl.NumberFormat('en-US');
const formatCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const formatCompact = { format(value) { return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : String(Math.round(value)); } };
const formatPercent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

async function fetchJson(path, options = {}) {
  const response = await fetch(api(path), {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json();
}

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = state.theme;
  const toggle = document.querySelector('#theme-toggle');
  if (toggle) {
    toggle.checked = state.theme === 'dark';
    toggle.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
  }
  drawLineChart();
}

function themeVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function loadData() {
  try {
    const settings = await fetchJson('/settings');
    setTheme(settings.theme);
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/summary'),
      fetchJson('/timeseries'),
      fetchJson('/categories'),
      fetchJson('/recent')
    ]);
    Object.assign(state, { summary, timeseries, categories, recent, error: null });
  } catch (error) {
    console.error(error);
    state.error = 'Unable to load dashboard data. Start the metrics API server and reload this page.';
  } finally {
    render();
  }
}

function statCards() {
  const s = state.summary;
  const trend = s.sevenDayTrendPercent;
  const direction = trend >= 0 ? 'up' : 'down';
  const bestDate = shortDate(s.bestDay.date);
  return [
    { label: 'Total Visitors', value: formatInt.format(s.totalVisitors), sub: '30-day cumulative traffic', trend: `${formatPercent.format(trend)}% 7-day`, direction },
    { label: 'Total Revenue', value: formatCurrency.format(s.totalRevenue), sub: 'Seeded deterministic revenue', trend: `${formatPercent.format(trend * 0.72)}% pace`, direction },
    { label: 'Best Day', value: formatInt.format(s.bestDay.visitors), sub: `${bestDate} by visitors`, trend: formatCurrency.format(s.bestDay.revenue), direction: 'neutral' },
    { label: 'Largest Segment', value: formatInt.format(state.categories[0]?.value ?? 0), sub: state.categories[0]?.label ?? 'No category', trend: '7-digit value check', direction: 'neutral' }
  ].map(card => `
    <article class="stat-card card">
      <div class="stat-label">${escapeHtml(card.label)}</div>
      <div class="stat-value" title="${escapeHtml(card.value)}">${escapeHtml(card.value)}</div>
      <div class="stat-footer">
        <span class="stat-sub" title="${escapeHtml(card.sub)}">${escapeHtml(card.sub)}</span>
        <span class="trend ${card.direction}">${escapeHtml(card.trend)}</span>
      </div>
    </article>
  `).join('');
}

function render() {
  if (state.chartResizeObserver) {
    state.chartResizeObserver.disconnect();
    state.chartResizeObserver = null;
  }

  if (state.error) {
    app.innerHTML = `
      <main class="shell">
        <header class="topbar">
          <div><p class="eyebrow">Metrics Dashboard</p><h1>Dashboard unavailable</h1></div>
        </header>
        <section class="error-state card" role="alert">
          <h2>Could not connect to the metrics API</h2>
          <p>${escapeHtml(state.error)}</p>
        </section>
      </main>`;
    return;
  }

  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="title-block">
          <p class="eyebrow">Metrics Dashboard</p>
          <h1>Executive overview</h1>
          <p class="lede">30 days of seeded product, revenue, and category activity.</p>
        </div>
        <label class="theme-switch">
          <span>Light</span>
          <input id="theme-toggle" type="checkbox" ${state.theme === 'dark' ? 'checked' : ''} />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          <span>Dark</span>
        </label>
      </header>

      <section class="stats-grid" aria-label="Summary statistics">${statCards()}</section>

      <section class="dashboard-grid">
        <article class="card chart-card">
          <div class="card-heading">
            <div><h2>Visitor trend</h2><p>Daily visitors across the last 30 days</p></div>
            <span class="badge">SVG / responsive</span>
          </div>
          <div id="line-chart" class="line-chart" role="img" aria-label="30 day visitor time-series chart"></div>
        </article>

        <article class="card category-card">
          <div class="card-heading"><div><h2>Category breakdown</h2><p>Revenue influence by segment</p></div></div>
          <div class="bar-list">${categoryBars()}</div>
        </article>

        <article class="card table-card">
          <div class="card-heading"><div><h2>Recent items</h2><p>Latest seeded account activity</p></div></div>
          ${recentTable()}
        </article>
      </section>
    </main>`;

  document.querySelector('#theme-toggle')?.addEventListener('change', onThemeToggle);
  setTheme(state.theme);
  drawLineChart();
  const chart = document.querySelector('#line-chart');
  if (chart && 'ResizeObserver' in window) {
    state.chartResizeObserver = new ResizeObserver(() => drawLineChart());
    state.chartResizeObserver.observe(chart);
  } else {
    window.addEventListener('resize', drawLineChart, { passive: true });
  }
}

async function onThemeToggle(event) {
  const next = event.currentTarget.checked ? 'dark' : 'light';
  setTheme(next);
  try {
    await fetchJson('/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    console.error(error);
    state.error = 'Theme preference could not be saved because the metrics API is unavailable.';
    render();
  }
}

function categoryBars() {
  const max = Math.max(...state.categories.map(c => c.value), 1);
  return state.categories.map((c) => `
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
        <span class="bar-value">${formatInt.format(c.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${Math.max(5, (c.value / max) * 100).toFixed(2)}%"></div></div>
    </div>
  `).join('');
}

function recentTable() {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Item</th><th>Category</th><th>Value</th><th>Date</th></tr></thead>
        <tbody>${state.recent.map(item => `
          <tr>
            <td data-label="Item"><span class="cell-main" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></td>
            <td data-label="Category"><span class="cell-muted" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
            <td data-label="Value">${formatCurrency.format(item.value)}</td>
            <td data-label="Date">${shortDate(item.created_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function drawLineChart() {
  const el = document.querySelector('#line-chart');
  if (!el || !state.timeseries.length) return;

  const width = Math.max(260, Math.floor(el.clientWidth));
  const height = Math.max(250, Math.floor(Math.min(380, Math.max(260, width * 0.48))));
  const margin = width < 420
    ? { top: 18, right: 16, bottom: 52, left: 46 }
    : { top: 20, right: 24, bottom: 56, left: 58 };
  const innerW = Math.max(10, width - margin.left - margin.right);
  const innerH = Math.max(10, height - margin.top - margin.bottom);
  const values = state.timeseries.map(d => Number(d.visitors));
  const min = Math.floor(Math.min(...values) * 0.94 / 100) * 100;
  const max = Math.ceil(Math.max(...values) * 1.04 / 100) * 100;
  const span = Math.max(1, max - min);
  const x = (i) => margin.left + (i / (values.length - 1)) * innerW;
  const y = (v) => margin.top + (1 - ((v - min) / span)) * innerH;
  const points = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const area = `${margin.left},${margin.top + innerH} ${points} ${margin.left + innerW},${margin.top + innerH}`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round((min + span * t) / 100) * 100);
  const xTickIdx = width < 420 ? [0, 14, 29] : [0, 7, 14, 21, 29];

  const grid = yTicks.map(t => {
    const yy = y(t);
    return `<g><line class="grid-line" x1="${margin.left}" x2="${margin.left + innerW}" y1="${yy}" y2="${yy}"/><text class="axis-label" x="${margin.left - 9}" y="${yy + 4}" text-anchor="end">${formatCompact.format(t)}</text></g>`;
  }).join('');

  const xTicks = xTickIdx.map(i => {
    const xx = x(i);
    return `<g><line class="tick-line" x1="${xx}" x2="${xx}" y1="${margin.top + innerH}" y2="${margin.top + innerH + 6}"/><text class="axis-label" x="${xx}" y="${height - 20}" text-anchor="middle">${monthDay(state.timeseries[i].date)}</text></g>`;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="chartArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${themeVar('--series')}" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="${themeVar('--series')}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <rect class="plot-bg" x="${margin.left}" y="${margin.top}" width="${innerW}" height="${innerH}" rx="10"/>
      ${grid}
      <line class="axis-line" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + innerH}"/>
      <line class="axis-line" x1="${margin.left}" x2="${margin.left + innerW}" y1="${margin.top + innerH}" y2="${margin.top + innerH}"/>
      ${xTicks}
      <polygon points="${area}" fill="url(#chartArea)"/>
      <polyline class="series-line" points="${points}" fill="none"/>
      <circle class="series-dot" cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="4"/>
    </svg>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function parseDate(value) {
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T12:00:00`
    : text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return new Date(normalized);
}

function shortDate(value) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(parseDate(value));
}

function monthDay(value) {
  return new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric' }).format(parseDate(value));
}

loadData();
