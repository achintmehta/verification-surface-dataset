import './styles.css';

const app = document.querySelector('#app');

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: document.documentElement.dataset.theme || 'light',
  chartObserver: null
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = state.theme;
  drawChart();
}

async function fetchJson(url, options) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function loadDashboard() {
  renderShell(true);
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/api/settings'),
      fetchJson('/api/summary'),
      fetchJson('/api/timeseries'),
      fetchJson('/api/categories'),
      fetchJson('/api/recent')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    setTheme(settings.theme);
    renderShell(false);
  } catch (error) {
    console.error(error);
    renderError();
  }
}

function headerMarkup() {
  const checked = state.theme === 'dark' ? 'checked' : '';
  return `
    <header class="topbar">
      <div class="title-block">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
      </div>
      <label class="theme-toggle" aria-label="Toggle dark theme">
        <span>Light</span>
        <input id="themeSwitch" type="checkbox" ${checked} />
        <span class="switch" aria-hidden="true"></span>
        <span>Dark</span>
      </label>
    </header>`;
}

function renderShell(loading) {
  app.innerHTML = `
    <main class="page">
      ${headerMarkup()}
      ${loading ? skeletonMarkup() : dashboardMarkup()}
    </main>`;
  bindThemeToggle();
  if (!loading) {
    drawChart();
    observeChart();
  }
}

function skeletonMarkup() {
  return `
    <section class="status-card" role="status">
      <div class="spinner"></div>
      <div><h2>Loading dashboard data…</h2><p>Fetching metrics from the PGLite-backed API.</p></div>
    </section>`;
}

function renderError() {
  app.innerHTML = `
    <main class="page">
      ${headerMarkup()}
      <section class="status-card error-state" role="alert">
        <strong>Dashboard data is unavailable.</strong>
        <p>The client could not reach the metrics API. Start the backend and reload; no hardcoded or stale data is shown.</p>
        <button id="retryButton" class="button">Retry</button>
      </section>
    </main>`;
  bindThemeToggle();
  document.querySelector('#retryButton')?.addEventListener('click', loadDashboard);
}

function dashboardMarkup() {
  return `
    <section class="stats-grid" aria-label="Summary statistics">
      ${statCard('Total visitors', number.format(state.summary.totalVisitors), `${trendText()} vs prior 7 days`, state.summary.sevenDayTrendPercent >= 0)}
      ${statCard('Total revenue', money.format(state.summary.totalRevenue), '30-day gross revenue', true)}
      ${statCard('Best revenue day', dateFmt.format(parseDate(state.summary.bestDay.date)), `${money.format(state.summary.bestDay.revenue)} · ${number.format(state.summary.bestDay.visitors)} visitors`, true)}
      ${statCard('Largest category', number.format(Math.max(...state.categories.map((c) => c.value))), state.categories[0].label, true)}
    </section>

    <section class="dashboard-grid">
      <article class="card chart-card">
        <div class="card-header">
          <div><p class="eyebrow">30 day series</p><h2>Visitors over time</h2></div>
          <span class="pill">SVG redraws on resize</span>
        </div>
        <div id="chartMount" class="chart-mount" aria-label="Line chart of daily visitors" role="img"></div>
      </article>

      <article class="card categories-card">
        <div class="card-header"><div><p class="eyebrow">Breakdown</p><h2>Category value</h2></div></div>
        <div class="bar-list">${categoryBars()}</div>
      </article>

      <article class="card table-card">
        <div class="card-header"><div><p class="eyebrow">Latest activity</p><h2>Recent items</h2></div></div>
        ${recentTable()}
      </article>
    </section>`;
}

function statCard(label, value, note, positive) {
  return `
    <article class="stat-card card">
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <span class="trend ${positive ? 'positive' : 'negative'}">${positive ? '▲' : '▼'} ${escapeHtml(note)}</span>
    </article>`;
}

function trendText() {
  const value = Math.abs(state.summary.sevenDayTrendPercent).toFixed(1);
  return `${state.summary.sevenDayTrendPercent >= 0 ? '+' : '-'}${value}%`;
}

function categoryBars() {
  const max = Math.max(...state.categories.map((c) => c.value), 1);
  return state.categories.map((category) => {
    const width = Math.max(4, (category.value / max) * 100);
    return `
      <div class="bar-row">
        <div class="bar-meta">
          <span class="bar-label" title="${escapeHtml(category.label)}">${escapeHtml(category.label)}</span>
          <strong class="bar-value">${number.format(category.value)}</strong>
        </div>
        <div class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${width}%"></span></div>
      </div>`;
  }).join('');
}

function recentTable() {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr></thead>
        <tbody>
          ${state.recent.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-main">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${money.format(item.value)}</td>
              <td data-label="Date">${dateFmt.format(new Date(item.createdAt))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function bindThemeToggle() {
  const input = document.querySelector('#themeSwitch');
  input?.addEventListener('change', async (event) => {
    const nextTheme = event.target.checked ? 'dark' : 'light';
    const previous = state.theme;
    setTheme(nextTheme);
    try {
      await fetchJson('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: nextTheme }) });
    } catch (error) {
      console.error(error);
      setTheme(previous);
      event.target.checked = previous === 'dark';
    }
  });
}

function observeChart() {
  state.chartObserver?.disconnect();
  const mount = document.querySelector('#chartMount');
  if (!mount) return;
  state.chartObserver = new ResizeObserver(() => drawChart());
  state.chartObserver.observe(mount);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart() {
  const mount = document.querySelector('#chartMount');
  if (!mount || state.timeseries.length === 0) return;
  const width = Math.max(300, Math.floor(mount.clientWidth));
  const height = Math.max(260, Math.floor(mount.clientHeight || 320));
  const margin = width < 430 ? { top: 18, right: 14, bottom: 42, left: 52 } : { top: 22, right: 24, bottom: 46, left: 62 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const values = state.timeseries.map((d) => d.visitors);
  const min = Math.floor(Math.min(...values) * 0.92 / 100) * 100;
  const max = Math.ceil(Math.max(...values) * 1.06 / 100) * 100;
  const span = Math.max(max - min, 1);
  const x = (index) => margin.left + (index / (state.timeseries.length - 1)) * innerW;
  const y = (value) => margin.top + innerH - ((value - min) / span) * innerH;
  const points = state.timeseries.map((d, i) => `${x(i).toFixed(2)},${y(d.visitors).toFixed(2)}`).join(' ');
  const gridTicks = 4;
  const xTickIndexes = width < 430 ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const grid = [];
  for (let i = 0; i <= gridTicks; i += 1) {
    const value = min + (span / gridTicks) * i;
    const yy = y(value);
    grid.push(`<line class="grid-line" x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}"></line>`);
    grid.push(`<text class="axis-label" x="${margin.left - 8}" y="${yy + 4}" text-anchor="end">${compact.format(value)}</text>`);
  }
  const xTicks = xTickIndexes.map((i) => {
    const xx = x(i);
    return `<g><line class="tick" x1="${xx}" y1="${height - margin.bottom}" x2="${xx}" y2="${height - margin.bottom + 5}"></line><text class="axis-label" x="${xx}" y="${height - 16}" text-anchor="middle">${dateFmt.format(parseDate(state.timeseries[i].date))}</text></g>`;
  }).join('');
  const areaPoints = `${margin.left},${height - margin.bottom} ${points} ${width - margin.right},${height - margin.bottom}`;

  mount.innerHTML = `
    <svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="seriesFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${cssVar('--series')}" stop-opacity="0.24" />
          <stop offset="100%" stop-color="${cssVar('--series')}" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      ${grid.join('')}
      <line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
      <line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"></line>
      ${xTicks}
      <polygon class="series-area" points="${areaPoints}"></polygon>
      <polyline class="series-line" points="${points}"></polyline>
      ${state.timeseries.map((d, i) => (i % 7 === 0 || i === state.timeseries.length - 1) ? `<circle class="series-point" cx="${x(i)}" cy="${y(d.visitors)}" r="3.2"><title>${d.date}: ${number.format(d.visitors)} visitors</title></circle>` : '').join('')}
    </svg>`;
}

function parseDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

loadDashboard();
