import './styles.css';

const API = '/api';
const app = document.querySelector('#app');

const fmtInt = new Intl.NumberFormat('en-US');
const fmtCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtDateLong = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

let dashboardData = null;
let resizeObserver = null;

init();

async function init() {
  renderShell();
  try {
    const settings = await fetchJson(`${API}/settings`);
    applyTheme(settings.theme);
    document.documentElement.classList.remove('theme-loading');

    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJson(`${API}/summary`),
      fetchJson(`${API}/timeseries`),
      fetchJson(`${API}/categories`),
      fetchJson(`${API}/recent`)
    ]);

    dashboardData = { summary, timeseries, categories, recent };
    renderDashboard(dashboardData);
  } catch (error) {
    console.error(error);
    document.documentElement.classList.remove('theme-loading');
    renderError(error);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function renderShell() {
  app.innerHTML = `
    <div class="page-shell">
      <header class="topbar">
        <div class="title-wrap">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false">
          <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
          <span class="toggle-text">Light</span>
        </button>
      </header>
      <main id="content" class="content" aria-live="polite">
        <section class="loading-state card">Loading dashboard metrics…</section>
      </main>
    </div>
  `;
  document.querySelector('.theme-toggle').addEventListener('click', toggleTheme);
}

function renderDashboard(data) {
  const { summary } = data;
  const content = document.querySelector('#content');
  content.innerHTML = `
    <section class="stats-grid" aria-label="Summary metrics">
      ${statCard('Total visitors', fmtInt.format(summary.totalVisitors), '30-day total', 'up')}
      ${statCard('Total revenue', fmtCurrency.format(summary.totalRevenue), '30-day total', 'up')}
      ${statCard('Best day', fmtInt.format(summary.bestDay.visitors), `${fmtDateLong.format(toLocalDate(summary.bestDay.date))} visitors`, 'up')}
      ${statCard('7-day trend', `${summary.sevenDayTrendPct >= 0 ? '+' : ''}${summary.sevenDayTrendPct.toFixed(1)}%`, 'vs prior 7 days', summary.sevenDayTrendPct >= 0 ? 'up' : 'down')}
    </section>

    <section class="body-grid">
      <article class="card chart-card">
        <div class="card-head">
          <div>
            <h2>30-day visitors</h2>
            <p>Daily traffic trend</p>
          </div>
        </div>
        <div id="lineChart" class="chart-box" role="img" aria-label="Line chart of daily visitors over 30 days"></div>
      </article>

      <article class="card category-card">
        <div class="card-head">
          <div>
            <h2>Category breakdown</h2>
            <p>Seeded category values</p>
          </div>
        </div>
        <div class="bars" id="categoryBars"></div>
      </article>
    </section>

    <section class="card table-card">
      <div class="card-head">
        <div>
          <h2>Recent items</h2>
          <p>Latest seeded records from PGLite</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Value</th><th scope="col">Created</th></tr>
          </thead>
          <tbody id="recentRows"></tbody>
        </table>
      </div>
    </section>
  `;

  renderBars(data.categories);
  renderRecent(data.recent);
  setupChart(data.timeseries);
}

function statCard(label, value, meta, direction) {
  return `
    <article class="card stat-card">
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <span class="stat-meta ${direction === 'down' ? 'negative' : 'positive'}">
        <span aria-hidden="true">${direction === 'down' ? '↘' : '↗'}</span>${escapeHtml(meta)}
      </span>
    </article>
  `;
}

function renderBars(categories) {
  const max = Math.max(...categories.map((c) => c.value), 1);
  document.querySelector('#categoryBars').innerHTML = categories.map((category) => {
    const width = Math.max(7, (category.value / max) * 100);
    return `
      <div class="bar-row">
        <div class="bar-top">
          <span class="bar-label" title="${escapeHtml(category.label)}">${escapeHtml(category.label)}</span>
          <span class="bar-value">${fmtInt.format(category.value)}</span>
        </div>
        <div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div>
      </div>
    `;
  }).join('');
}

function renderRecent(items) {
  document.querySelector('#recentRows').innerHTML = items.map((item) => `
    <tr>
      <td data-label="Name"><span class="cell-primary">${escapeHtml(item.name)}</span></td>
      <td data-label="Category"><span class="truncate">${escapeHtml(item.category)}</span></td>
      <td data-label="Value">${fmtCurrency.format(item.value)}</td>
      <td data-label="Created">${fmtDateLong.format(new Date(item.createdAt))}</td>
    </tr>
  `).join('');
}

function setupChart(timeseries) {
  const container = document.querySelector('#lineChart');
  const redraw = () => drawLineChart(container, timeseries);
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver(redraw);
  resizeObserver.observe(container);
  redraw();
}

function drawLineChart(container, rawData) {
  const rect = container.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height || 320));
  const compact = width < 430;
  const margin = compact
    ? { top: 18, right: 28, bottom: 44, left: 43 }
    : { top: 22, right: 20, bottom: 50, left: 56 };
  const innerW = Math.max(1, width - margin.left - margin.right);
  const innerH = Math.max(1, height - margin.top - margin.bottom);

  const data = rawData.map((d) => ({ ...d, dateObj: toLocalDate(d.date), visitors: Number(d.visitors) }));
  const values = data.map((d) => d.visitors);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  const pad = Math.max(80, (maxRaw - minRaw) * 0.12);
  const min = Math.max(0, Math.floor((minRaw - pad) / 100) * 100);
  const max = Math.ceil((maxRaw + pad) / 100) * 100;
  const x = (i) => margin.left + (data.length === 1 ? 0 : (i / (data.length - 1)) * innerW);
  const y = (value) => margin.top + (1 - (value - min) / (max - min || 1)) * innerH;

  const yTicks = 4;
  const grid = [];
  for (let i = 0; i <= yTicks; i += 1) {
    const val = min + ((max - min) / yTicks) * i;
    const yy = y(val);
    grid.push(`<line class="grid-line" x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}"/>`);
    grid.push(`<text class="axis-label y-label" x="${margin.left - 8}" y="${yy + 4}" text-anchor="end">${fmtCompact.format(Math.round(val))}</text>`);
  }

  const tickIndexes = compact ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const xTicks = tickIndexes.map((idx) => {
    const xx = x(idx);
    return `<line class="tick-line" x1="${xx}" y1="${height - margin.bottom}" x2="${xx}" y2="${height - margin.bottom + 5}"/>
      <text class="axis-label" x="${xx}" y="${height - margin.bottom + 22}" text-anchor="middle">${fmtDate.format(data[idx].dateObj)}</text>`;
  }).join('');

  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ');
  const area = `${path} L ${x(data.length - 1).toFixed(2)} ${height - margin.bottom} L ${margin.left} ${height - margin.bottom} Z`;
  const points = data.map((d, i) => `<circle class="series-dot" cx="${x(i).toFixed(2)}" cy="${y(d.visitors).toFixed(2)}" r="${compact ? 2.2 : 2.8}"></circle>`).join('');

  container.innerHTML = `
    <svg class="line-svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" focusable="false" aria-hidden="true">
      <rect class="plot-bg" x="0" y="0" width="${width}" height="${height}" rx="14"></rect>
      <g>${grid.join('')}</g>
      <line class="axis-line" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"/>
      <line class="axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"/>
      <g>${xTicks}</g>
      <path class="area-fill" d="${area}"></path>
      <path class="series-line" d="${path}"></path>
      <g>${points}</g>
    </svg>
  `;
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await fetchJson(`${API}/settings`, { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    console.error(error);
    renderToast('Theme changed locally, but saving failed.');
  }
  if (dashboardData?.timeseries) {
    drawLineChart(document.querySelector('#lineChart'), dashboardData.timeseries);
  }
}

function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  const button = document.querySelector('.theme-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(normalized === 'dark'));
    button.querySelector('.toggle-text').textContent = normalized === 'dark' ? 'Dark' : 'Light';
  }
}

function renderError(error) {
  const content = document.querySelector('#content');
  content.innerHTML = `
    <section class="empty-state card" role="alert">
      <h2>Dashboard data unavailable</h2>
      <p>The dashboard renders only from the JSON API. Start the backend server and reload this page.</p>
      <code>${escapeHtml(error.message)}</code>
    </section>
  `;
}

function renderToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function toLocalDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
