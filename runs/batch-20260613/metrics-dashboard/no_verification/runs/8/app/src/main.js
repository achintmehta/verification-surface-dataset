import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  resizeObserver: null
};

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function api(path, options) {
  return fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  }).then(async (res) => {
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body.error) message = body.error;
      } catch (_) {}
      throw new Error(message);
    }
    return res.json();
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatDate(dateString, options = { month: 'short', day: 'numeric' }) {
  const d = new Date(`${dateString}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(d);
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  try { sessionStorage.setItem('preferred-theme-hint', state.theme); } catch (_) {}
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
    toggle.querySelector('.toggle-text').textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  }
  drawChart();
}

function shell() {
  document.querySelector('#app').innerHTML = `
    <div class="page-shell">
      <header class="topbar">
        <div class="title-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button id="themeToggle" class="theme-toggle" type="button" aria-pressed="false">
          <span class="toggle-icon" aria-hidden="true"></span>
          <span class="toggle-text">Light</span>
        </button>
      </header>
      <main id="main" class="dashboard" aria-live="polite">
        <section class="loading-card">Loading dashboard metrics…</section>
      </main>
    </div>
  `;
  document.querySelector('#themeToggle').addEventListener('click', onToggleTheme);
}

function renderDashboard() {
  const main = document.querySelector('#main');
  const stats = [
    { label: 'Total visitors', value: integer.format(state.summary.totalVisitors), helper: `${trendText(state.summary.sevenDayTrendPct)} vs previous 7 days`, tone: state.summary.sevenDayTrendPct >= 0 ? 'positive' : 'negative' },
    { label: 'Total revenue', value: currency.format(state.summary.totalRevenue), helper: '30-day booked revenue', tone: 'neutral' },
    { label: 'Best day', value: integer.format(state.summary.bestDay.visitors), helper: `${formatDate(state.summary.bestDay.date)} • ${currency.format(state.summary.bestDay.revenue)}`, tone: 'positive' },
    { label: '7-day trend', value: trendText(state.summary.sevenDayTrendPct), helper: 'Visitors vs previous 7 days', tone: state.summary.sevenDayTrendPct >= 0 ? 'positive' : 'negative' }
  ];

  main.innerHTML = `
    <section class="stats-grid" aria-label="Summary statistics">
      ${stats.map((stat) => `
        <article class="card stat-card">
          <div class="stat-label">${escapeHtml(stat.label)}</div>
          <div class="stat-number" title="${escapeHtml(stat.value)}">${escapeHtml(stat.value)}</div>
          <div class="stat-helper ${stat.tone}">${stat.tone !== 'neutral' ? '<span class="trend-dot"></span>' : ''}${stat.helper}</div>
        </article>
      `).join('')}
    </section>

    <section class="body-grid">
      <article class="card chart-card">
        <div class="card-heading">
          <div>
            <h2>30-day visitors</h2>
            <p>Daily visitor counts from the seeded metrics table.</p>
          </div>
        </div>
        <div id="chartHost" class="chart-host" role="img" aria-label="Line chart of visitors for the last 30 days"></div>
      </article>

      <article class="card breakdown-card">
        <div class="card-heading">
          <div>
            <h2>Category breakdown</h2>
            <p>Horizontal bars scale to the largest segment.</p>
          </div>
        </div>
        <div class="bars" aria-label="Category values">
          ${renderBars()}
        </div>
      </article>
    </section>

    <section class="card table-card">
      <div class="card-heading table-heading">
        <div>
          <h2>Recent items</h2>
          <p>Latest 20 seeded records.</p>
        </div>
      </div>
      ${renderTable()}
    </section>
  `;

  if (state.resizeObserver) state.resizeObserver.disconnect();
  const host = document.querySelector('#chartHost');
  state.resizeObserver = new ResizeObserver(() => drawChart());
  state.resizeObserver.observe(host);
  drawChart();
}

function trendText(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function renderBars() {
  const max = Math.max(...state.categories.map((c) => c.value), 1);
  return state.categories.map((cat) => {
    const pct = Math.max(4, Math.round((cat.value / max) * 100));
    return `
      <div class="bar-row">
        <div class="bar-meta">
          <span class="bar-label" title="${escapeHtml(cat.label)}">${escapeHtml(cat.label)}</span>
          <span class="bar-value">${currency.format(cat.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${pct}%"></span></div>
      </div>
    `;
  }).join('');
}

function renderTable() {
  return `
    <div class="table-wrap">
      <table aria-label="Recent dashboard items">
        <thead>
          <tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${state.recent.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-main" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${currency.format(item.value)}</td>
              <td data-label="Date">${formatRecentDate(item.createdAt)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function formatRecentDate(value) {
  const d = new Date(value);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceTicks(min, max, count) {
  const span = Math.max(1, max - min);
  const raw = span / Math.max(1, count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(v);
  return ticks.slice(-6);
}

function drawChart() {
  const host = document.querySelector('#chartHost');
  if (!host || !state.timeseries.length) return;

  const width = Math.max(240, Math.floor(host.clientWidth));
  const height = Math.max(260, Math.floor(host.clientHeight || 300));
  const compactMode = width < 430;
  const margin = { top: 18, right: compactMode ? 12 : 22, bottom: compactMode ? 54 : 46, left: compactMode ? 48 : 62 };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = Math.max(10, height - margin.top - margin.bottom);
  const values = state.timeseries.map((d) => d.visitors);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1000, Math.round((max - min) * 0.08));
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const x = (i) => margin.left + (i / (state.timeseries.length - 1)) * plotW;
  const y = (v) => margin.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const points = state.timeseries.map((d, i) => `${x(i).toFixed(1)},${y(d.visitors).toFixed(1)}`).join(' ');
  const yTicks = niceTicks(yMin, yMax, compactMode ? 4 : 5);
  const lastIndex = state.timeseries.length - 1;
  const xIndexes = compactMode ? [0, Math.round(lastIndex / 3), Math.round((lastIndex * 2) / 3), lastIndex] : [0, Math.round(lastIndex * 0.2), Math.round(lastIndex * 0.4), Math.round(lastIndex * 0.6), Math.round(lastIndex * 0.8), lastIndex];

  const grid = yTicks.map((tick) => {
    const yy = y(tick);
    return `<line class="grid-line" x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}"></line>
            <text class="axis-label y-label" x="${margin.left - 8}" y="${yy + 4}" text-anchor="end">${compact.format(tick)}</text>`;
  }).join('');

  const xLabels = xIndexes.map((i) => {
    const xx = x(i);
    const anchor = i === 0 ? 'start' : i === lastIndex ? 'end' : 'middle';
    return `<line class="tick-line" x1="${xx}" y1="${margin.top + plotH}" x2="${xx}" y2="${margin.top + plotH + 5}"></line>
            <text class="axis-label" x="${xx}" y="${height - 18}" text-anchor="${anchor}">${formatDate(state.timeseries[i].date, { month: 'short', day: 'numeric' })}</text>`;
  }).join('');

  host.innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}" rx="14"></rect>
      <g>${grid}</g>
      <line class="axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}"></line>
      <line class="axis-line" x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}"></line>
      <g>${xLabels}</g>
      <polyline class="series-line" points="${points}" fill="none"></polyline>
      ${state.timeseries.map((d, i) => `<circle class="series-point" cx="${x(i)}" cy="${y(d.visitors)}" r="${compactMode ? 2.2 : 2.8}"><title>${formatDate(d.date)}: ${integer.format(d.visitors)} visitors</title></circle>`).join('')}
    </svg>
  `;
}

function renderError(error) {
  const main = document.querySelector('#main');
  main.innerHTML = `
    <section class="error-card" role="alert">
      <h2>Dashboard data unavailable</h2>
      <p>The dashboard renders only from live API data. Start the backend server and refresh this page.</p>
      <pre>${escapeHtml(error.message || String(error))}</pre>
      <button id="retryButton" type="button">Retry</button>
    </section>
  `;
  document.querySelector('#retryButton').addEventListener('click', load);
}

async function onToggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    console.error(error);
  }
}

async function load() {
  const main = document.querySelector('#main');
  main.innerHTML = '<section class="loading-card">Loading dashboard metrics…</section>';
  try {
    const settings = await api('/api/settings');
    applyTheme(settings.theme);
    document.documentElement.classList.remove('theme-loading');
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    renderDashboard();
  } catch (error) {
    document.documentElement.classList.remove('theme-loading');
    renderError(error);
  }
}

shell();
applyTheme(state.theme);
load();
