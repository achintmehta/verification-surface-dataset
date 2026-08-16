import './styles.css';

const app = document.querySelector('#app');
const numberFormatter = new Intl.NumberFormat('en-US');
const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

let state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: document.documentElement.dataset.theme || 'light',
};
let resizeObserver = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function api(path, options) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    cache: 'no-store',
    ...options,
  }).then(async (response) => {
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(message || `Request failed: ${response.status}`);
    }
    return response.json();
  });
}

function formatDate(date) {
  return dateFormatter.format(new Date(`${date}T00:00:00Z`));
}

function renderShell() {
  app.innerHTML = `
    <header class="site-header">
      <div class="title-block">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
      </div>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle dark theme">
        <span class="toggle-track" aria-hidden="true"><span class="toggle-dot"></span></span>
        <span id="themeLabel">${state.theme === 'dark' ? 'Dark' : 'Light'}</span>
      </button>
    </header>
    <main id="dashboard" class="dashboard" aria-live="polite">
      <section class="loading-card">Loading dashboard data…</section>
    </main>
  `;
  document.querySelector('#themeToggle').addEventListener('click', toggleTheme);
}

function renderError(error) {
  const dashboard = document.querySelector('#dashboard');
  dashboard.innerHTML = `
    <section class="error-state">
      <h2>Dashboard data is unavailable</h2>
      <p>The page renders from the API only. Start the backend server and retry to load metrics.</p>
      <pre>${escapeHtml(error.message || error)}</pre>
      <button id="retryButton" type="button">Retry</button>
    </section>
  `;
  document.querySelector('#retryButton').addEventListener('click', loadData);
}

function statCards(summary) {
  const statData = [
    { label: 'Total Visitors', value: numberFormatter.format(summary.totalVisitors), note: '30-day total', trend: `${summary.sevenDayTrend >= 0 ? '+' : ''}${summary.sevenDayTrend}% last 7 days` },
    { label: 'Total Revenue', value: moneyFormatter.format(summary.totalRevenue), note: '30-day total', trend: 'Seeded from PGLite' },
    { label: 'Best Day', value: formatDate(summary.bestDay.date), note: `${numberFormatter.format(summary.bestDay.visitors)} visitors`, trend: moneyFormatter.format(summary.bestDay.revenue) },
    { label: '7-Day Trend', value: `${summary.sevenDayTrend >= 0 ? '+' : ''}${summary.sevenDayTrend}%`, note: 'Visitors vs previous week', trend: summary.sevenDayTrend >= 0 ? 'Improving' : 'Cooling' },
  ];
  return statData.map((stat) => `
    <article class="card stat-card">
      <div class="stat-label">${escapeHtml(stat.label)}</div>
      <div class="stat-value" title="${escapeHtml(stat.value)}">${escapeHtml(stat.value)}</div>
      <div class="stat-note">${escapeHtml(stat.note)}</div>
      <div class="stat-trend ${summary.sevenDayTrend >= 0 ? 'positive' : 'negative'}">${escapeHtml(stat.trend)}</div>
    </article>
  `).join('');
}

function renderDashboard() {
  const dashboard = document.querySelector('#dashboard');
  dashboard.innerHTML = `
    <section class="stats-grid" aria-label="Summary statistics">
      ${statCards(state.summary)}
    </section>
    <section class="body-grid">
      <article class="card chart-card">
        <div class="card-heading">
          <div>
            <h2>30-day Visitors</h2>
            <p>Hand-drawn SVG line chart</p>
          </div>
        </div>
        <div id="chartHost" class="chart-host" role="img" aria-label="30-day visitors line chart"></div>
      </article>
      <article class="card breakdown-card">
        <div class="card-heading">
          <div>
            <h2>Category Breakdown</h2>
            <p>Revenue contribution by segment</p>
          </div>
        </div>
        <div class="bars" id="barsHost">${renderBars()}</div>
      </article>
    </section>
    <section class="card table-card">
      <div class="card-heading">
        <div>
          <h2>Recent Items</h2>
          <p>Latest seeded activity</p>
        </div>
      </div>
      ${renderTable()}
    </section>
  `;
  observeChart();
}

function renderBars() {
  const max = Math.max(...state.categories.map((item) => item.value), 1);
  return state.categories.map((item) => {
    const width = Math.max(6, (item.value / max) * 100);
    return `
      <div class="bar-row">
        <div class="bar-topline">
          <span class="bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
          <span class="bar-value">${numberFormatter.format(item.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${width}%"></div></div>
      </div>
    `;
  }).join('');
}

function renderTable() {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${state.recent.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-main">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${moneyFormatter.format(item.value)}</td>
              <td data-label="Date">${dateFormatter.format(new Date(item.createdAt))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function observeChart() {
  if (resizeObserver) resizeObserver.disconnect();
  const host = document.querySelector('#chartHost');
  if (!host) return;
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width } = entry.contentRect;
      drawChart(host, Math.max(0, Math.floor(width)));
    }
  });
  resizeObserver.observe(host);
  requestAnimationFrame(() => drawChart(host, Math.floor(host.getBoundingClientRect().width)));
}

function drawChart(host, width) {
  if (!host || !state.timeseries.length || width <= 0) return;
  const height = width < 430 ? 260 : 320;
  const margin = {
    top: 22,
    right: width < 420 ? 12 : 22,
    bottom: width < 420 ? 54 : 48,
    left: width < 420 ? 46 : 58,
  };
  const innerW = Math.max(24, width - margin.left - margin.right);
  const innerH = Math.max(80, height - margin.top - margin.bottom);
  const visitors = state.timeseries.map((d) => d.visitors);
  const minRaw = Math.min(...visitors);
  const maxRaw = Math.max(...visitors);
  const pad = Math.max(10, (maxRaw - minRaw) * 0.12);
  const min = Math.max(0, Math.floor((minRaw - pad) / 100) * 100);
  const max = Math.ceil((maxRaw + pad) / 100) * 100;
  const x = (index) => margin.left + (state.timeseries.length === 1 ? innerW / 2 : (index / (state.timeseries.length - 1)) * innerW);
  const y = (value) => margin.top + (1 - (value - min) / (max - min || 1)) * innerH;
  const points = state.timeseries.map((d, i) => `${x(i).toFixed(1)},${y(d.visitors).toFixed(1)}`).join(' ');
  const gridTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(max - ratio * (max - min)));
  const xTickIndexes = width < 420 ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const axis = cssVar('--axis');
  const grid = cssVar('--grid');
  const text = cssVar('--muted');
  const series = cssVar('--series');
  const fill = cssVar('--series-fill');
  const areaPoints = `${margin.left},${margin.top + innerH} ${points} ${margin.left + innerW},${margin.top + innerH}`;

  host.innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="presentation" preserveAspectRatio="none">
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      ${gridTicks.map((tick) => {
        const gy = y(tick);
        return `<g><line x1="${margin.left}" x2="${margin.left + innerW}" y1="${gy}" y2="${gy}" stroke="${grid}" stroke-width="1"/><text x="${margin.left - 8}" y="${gy + 4}" text-anchor="end" fill="${text}" font-size="11">${compactFormatter.format(tick)}</text></g>`;
      }).join('')}
      <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + innerH}" stroke="${axis}" stroke-width="1.2"/>
      <line x1="${margin.left}" x2="${margin.left + innerW}" y1="${margin.top + innerH}" y2="${margin.top + innerH}" stroke="${axis}" stroke-width="1.2"/>
      ${xTickIndexes.map((i) => {
        const gx = x(i);
        return `<g><line x1="${gx}" x2="${gx}" y1="${margin.top + innerH}" y2="${margin.top + innerH + 5}" stroke="${axis}"/><text x="${gx}" y="${margin.top + innerH + 22}" text-anchor="middle" fill="${text}" font-size="11">${formatDate(state.timeseries[i].date)}</text></g>`;
      }).join('')}
      <polygon points="${areaPoints}" fill="${fill}" opacity="0.34"></polygon>
      <polyline points="${points}" fill="none" stroke="${series}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${state.timeseries.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d.visitors).toFixed(1)}" r="${width < 420 ? 2.4 : 3.2}" fill="${series}"><title>${d.date}: ${numberFormatter.format(d.visitors)} visitors</title></circle>`).join('')}
    </svg>
  `;
}

async function toggleTheme() {
  const previous = state.theme;
  const next = previous === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
    applyTheme(saved.theme);
  } catch (error) {
    applyTheme(previous);
    alert('Could not persist theme preference. Is the backend running?');
  }
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const label = document.querySelector('#themeLabel');
  if (label) label.textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  const toggle = document.querySelector('#themeToggle');
  if (toggle) toggle.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
  const host = document.querySelector('#chartHost');
  if (host) drawChart(host, Math.floor(host.getBoundingClientRect().width));
}

async function loadData() {
  const dashboard = document.querySelector('#dashboard');
  if (dashboard) dashboard.innerHTML = '<section class="loading-card">Loading dashboard data…</section>';
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      api('/api/settings'),
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent'),
    ]);
    state = { ...state, theme: settings.theme, summary, timeseries, categories, recent };
    applyTheme(settings.theme);
    renderDashboard();
  } catch (error) {
    renderError(error);
  }
}

renderShell();
applyTheme(state.theme);
loadData();
