import './styles.css';

const app = document.querySelector('#app');
const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  resizeObserver: null
};

const numberFormatter = new Intl.NumberFormat('en-US');
const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.classList.remove('theme-loading');
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.checked = state.theme === 'dark';
    toggle.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
  }
  drawLineChart();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

async function loadDashboard() {
  renderShell('loading');
  try {
    const settings = await fetchJson('/api/settings');
    applyTheme(settings.theme);
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/api/summary'),
      fetchJson('/api/timeseries'),
      fetchJson('/api/categories'),
      fetchJson('/api/recent')
    ]);
    Object.assign(state, { summary, timeseries, categories, recent });
    renderShell('ready');
    applyTheme(state.theme);
    setupResizeObserver();
    drawLineChart();
  } catch (error) {
    console.error(error);
    document.documentElement.classList.remove('theme-loading');
    renderShell('error');
  }
}

function renderShell(mode) {
  app.innerHTML = `
    <div class="page-shell">
      <header class="dashboard-header">
        <div class="title-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Seeded PostgreSQL metrics rendered responsively without chart libraries.</p>
        </div>
        <label class="theme-switch" for="themeToggle">
          <span>Light</span>
          <input id="themeToggle" type="checkbox" ${state.theme === 'dark' ? 'checked' : ''} />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          <span>Dark</span>
        </label>
      </header>
      <main>
        ${mode === 'loading' ? loadingMarkup() : ''}
        ${mode === 'error' ? errorMarkup() : ''}
        ${mode === 'ready' ? dashboardMarkup() : ''}
      </main>
    </div>
  `;

  document.querySelector('#themeToggle')?.addEventListener('change', handleThemeToggle);
}

function loadingMarkup() {
  return `<section class="state-card"><h2>Loading dashboard…</h2><p>Fetching metrics from the API.</p></section>`;
}

function errorMarkup() {
  return `<section class="state-card error"><h2>Unable to load dashboard data</h2><p>The dashboard renders only from live API data. Start the backend server and reload this page.</p><button id="retryButton" class="button">Retry</button></section>`;
}

function dashboardMarkup() {
  return `
    <section class="stats-grid" aria-label="Summary statistics">
      ${statCard('Total visitors', numberFormatter.format(state.summary.totalVisitors), `${trendText(state.summary.sevenDayTrend)} vs previous 7 days`, 'visitors')}
      ${statCard('Total revenue', moneyFormatter.format(state.summary.totalRevenue), '30-day gross revenue', 'revenue')}
      ${statCard('Best day', shortDate.format(new Date(`${state.summary.bestDay.day}T00:00:00Z`)), `${moneyFormatter.format(state.summary.bestDay.revenue)} revenue`, 'best')}
      ${statCard('7-day trend', `${state.summary.sevenDayTrend >= 0 ? '+' : ''}${state.summary.sevenDayTrend.toFixed(1)}%`, 'Visitor average change', state.summary.sevenDayTrend >= 0 ? 'up' : 'down')}
    </section>

    <section class="body-grid">
      <article class="panel chart-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">30 days</p><h2>Visitors over time</h2></div>
          <span class="legend-dot">Visitors</span>
        </div>
        <div id="lineChart" class="chart-frame" role="img" aria-label="Line chart of visitors for the last 30 days"></div>
      </article>

      <article class="panel category-panel">
        <div class="panel-heading"><div><p class="eyebrow">Breakdown</p><h2>Category value</h2></div></div>
        <div class="category-list">${categoryMarkup()}</div>
      </article>
    </section>

    <section class="panel table-panel">
      <div class="panel-heading"><div><p class="eyebrow">Latest</p><h2>Recent items</h2></div></div>
      ${recentMarkup()}
    </section>
  `;
}

function statCard(label, value, meta, tone) {
  return `
    <article class="stat-card tone-${tone}">
      <p>${label}</p>
      <strong title="${escapeHtml(value)}">${value}</strong>
      <span>${meta}</span>
    </article>
  `;
}

function trendText(value) {
  return `${value >= 0 ? '▲' : '▼'} ${Math.abs(value).toFixed(1)}%`;
}

function categoryMarkup() {
  const max = Math.max(...state.categories.map((item) => item.value));
  return state.categories.map((item) => {
    const percent = Math.max(8, (item.value / max) * 100);
    return `
      <div class="category-row">
        <div class="category-topline"><span class="category-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span><span class="category-value">${numberFormatter.format(item.value)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${percent.toFixed(2)}%"></div></div>
      </div>
    `;
  }).join('');
}

function recentMarkup() {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
        <tbody>
          ${state.recent.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-main">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${moneyFormatter.format(item.value)}</td>
              <td data-label="Created">${shortDate.format(new Date(item.created_at))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function handleThemeToggle(event) {
  const nextTheme = event.target.checked ? 'dark' : 'light';
  applyTheme(nextTheme);
  try {
    await fetchJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: nextTheme })
    });
  } catch (error) {
    console.error(error);
  }
}

function setupResizeObserver() {
  state.resizeObserver?.disconnect();
  const frame = document.querySelector('#lineChart');
  if (!frame) return;
  state.resizeObserver = new ResizeObserver(() => drawLineChart());
  state.resizeObserver.observe(frame);
  window.addEventListener('resize', drawLineChart, { passive: true });
}

function drawLineChart() {
  const frame = document.querySelector('#lineChart');
  if (!frame || state.timeseries.length === 0) return;

  const rect = frame.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height || 320));
  const small = width < 430;
  const margin = { top: 26, right: small ? 14 : 24, bottom: small ? 58 : 52, left: small ? 48 : 64 };
  const innerWidth = Math.max(10, width - margin.left - margin.right);
  const innerHeight = Math.max(10, height - margin.top - margin.bottom);
  const values = state.timeseries.map((d) => d.visitors);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max(40, (max - min) * 0.12);
  const yMin = Math.max(0, min - padding);
  const yMax = max + padding;
  const x = (index) => margin.left + (index / (values.length - 1)) * innerWidth;
  const y = (value) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * innerHeight;
  const points = values.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
  const path = values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(' ');
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const xTickIndexes = small ? [0, 14, 29] : [0, 7, 14, 21, 29];

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}" rx="18"></rect>
      ${yTicks.map((tick) => `<line class="gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick).toFixed(2)}" y2="${y(tick).toFixed(2)}"></line><text class="axis-label y-label" x="${margin.left - 10}" y="${(y(tick) + 4).toFixed(2)}" text-anchor="end">${numberFormatter.format(Math.round(tick))}</text>`).join('')}
      <line class="axis" x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}"></line>
      <line class="axis" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}"></line>
      ${xTickIndexes.map((index) => `<line class="tick" x1="${x(index).toFixed(2)}" x2="${x(index).toFixed(2)}" y1="${height - margin.bottom}" y2="${height - margin.bottom + 6}"></line><text class="axis-label x-label" x="${x(index).toFixed(2)}" y="${height - margin.bottom + 23}" text-anchor="middle">${shortDate.format(new Date(`${state.timeseries[index].date}T00:00:00Z`))}</text>`).join('')}
      <polyline class="series-shadow" points="${points}" fill="none"></polyline>
      <path class="series-line" d="${path}" fill="none"></path>
      ${values.map((value, index) => `<circle class="series-point ${index % (small ? 5 : 3) === 0 || index === values.length - 1 ? '' : 'minor'}" cx="${x(index).toFixed(2)}" cy="${y(value).toFixed(2)}" r="${small ? 2.5 : 3.5}"></circle>`).join('')}
    </svg>
  `;
  frame.innerHTML = svg;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

document.addEventListener('click', (event) => {
  if (event.target?.id === 'retryButton') loadDashboard();
});

loadDashboard();
