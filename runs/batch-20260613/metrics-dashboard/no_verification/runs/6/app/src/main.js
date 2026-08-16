import './styles.css';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const app = document.querySelector('#app');

const formatInteger = new Intl.NumberFormat('en-US');
const formatCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});
const formatDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const formatLongDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  chartObserver: null
};

function endpoint(path) {
  return `${API_BASE}${path}`;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(endpoint(path), {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', state.theme);
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
    toggle.querySelector('.toggle-text').textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  }
  requestAnimationFrame(drawChart);
}

async function loadDashboard() {
  renderLoading();
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
    renderDashboard();
  } catch (error) {
    renderError(error);
  }
}

function renderLoading() {
  app.className = 'app-shell loading-shell';
  app.innerHTML = `
    <main class="loading-card" aria-live="polite">
      <span class="loading-dot"></span>
      Fetching metrics from the API…
    </main>
  `;
}

function renderError(error) {
  if (state.chartObserver) state.chartObserver.disconnect();
  app.className = 'app-shell';
  app.innerHTML = `
    <main class="error-state">
      <div class="error-icon" aria-hidden="true">!</div>
      <h1>Dashboard data unavailable</h1>
      <p>The dashboard renders only from live API data. Start the backend server and retry.</p>
      <p class="error-detail">${escapeHtml(error.message)}</p>
      <button class="primary-button" id="retryButton" type="button">Retry</button>
    </main>
  `;
  document.querySelector('#retryButton').addEventListener('click', loadDashboard);
}

function renderDashboard() {
  if (state.chartObserver) state.chartObserver.disconnect();
  app.className = 'app-shell';
  app.innerHTML = `
    <header class="topbar">
      <div class="title-block">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
      </div>
      <button class="theme-toggle" id="themeToggle" type="button" aria-pressed="${state.theme === 'dark'}">
        <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
        <span class="toggle-text">${state.theme === 'dark' ? 'Dark' : 'Light'}</span>
      </button>
    </header>

    <main class="dashboard-grid">
      ${renderStatCards()}
      <section class="panel chart-panel" aria-labelledby="timeseriesTitle">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">30 day series</p>
            <h2 id="timeseriesTitle">Visitors over time</h2>
          </div>
          <span class="chart-legend"><i></i> Visitors</span>
        </div>
        <div class="chart-shell" id="chartShell" role="img" aria-label="Line chart showing visitors for the last 30 days">
          <svg id="timeseriesChart" class="timeseries-chart" focusable="false"></svg>
        </div>
      </section>

      <section class="panel categories-panel" aria-labelledby="categoriesTitle">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">Breakdown</p>
            <h2 id="categoriesTitle">Category value</h2>
          </div>
        </div>
        <div class="featured-category" aria-label="Largest seeded category">
          <span class="featured-label">Largest</span>
          <strong>${formatInteger.format(Math.max(...state.categories.map((c) => c.value)))}</strong>
        </div>
        <div class="category-list">
          ${renderCategories()}
        </div>
      </section>

      <section class="panel recent-panel" aria-labelledby="recentTitle">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">Latest 20</p>
            <h2 id="recentTitle">Recent items</h2>
          </div>
        </div>
        ${renderRecentTable()}
      </section>
    </main>
  `;

  document.querySelector('#themeToggle').addEventListener('click', toggleTheme);
  setupChartResize();
  drawChart();
  applyTheme(state.theme);
}

function renderStatCards() {
  const s = state.summary;
  const trendClass = s.sevenDayTrendPercent >= 0 ? 'positive' : 'negative';
  const trendSymbol = s.sevenDayTrendPercent >= 0 ? '↗' : '↘';
  const cards = [
    {
      label: 'Total visitors',
      value: formatInteger.format(s.totalVisitors),
      foot: '30-day cumulative audience',
      trend: `${trendSymbol} ${Math.abs(s.sevenDayTrendPercent).toFixed(1)}% 7-day trend`,
      trendClass
    },
    {
      label: 'Total revenue',
      value: formatCurrency.format(s.totalRevenue),
      foot: 'Seeded from daily revenue',
      trend: 'Revenue pipeline',
      trendClass: 'neutral'
    },
    {
      label: 'Best day',
      value: formatLongDate.format(new Date(`${s.bestDay.date}T00:00:00`)),
      foot: `${formatCurrency.format(s.bestDay.revenue)} revenue`,
      trend: `${formatInteger.format(s.bestDay.visitors)} visitors`,
      trendClass: 'neutral'
    },
    {
      label: '7-day trend',
      value: `${s.sevenDayTrendPercent >= 0 ? '+' : ''}${s.sevenDayTrendPercent.toFixed(1)}%`,
      foot: 'Recent week vs prior week',
      trend: s.sevenDayTrendPercent >= 0 ? 'Visitor growth' : 'Visitor decline',
      trendClass
    }
  ];

  return cards.map((card) => `
    <section class="stat-card" aria-label="${escapeHtml(card.label)}">
      <p class="stat-label">${escapeHtml(card.label)}</p>
      <strong class="stat-value">${escapeHtml(card.value)}</strong>
      <p class="stat-foot">${escapeHtml(card.foot)}</p>
      <span class="stat-trend ${card.trendClass}">${escapeHtml(card.trend)}</span>
    </section>
  `).join('');
}

function renderCategories() {
  const max = Math.max(...state.categories.map((category) => category.value), 1);
  return state.categories.map((category) => {
    const width = Math.max(4, (category.value / max) * 100);
    return `
      <div class="category-row">
        <div class="category-meta">
          <span class="category-label" title="${escapeHtml(category.label)}">${escapeHtml(category.label)}</span>
          <span class="category-value">${formatInteger.format(category.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true">
          <div class="bar-fill" style="width:${width.toFixed(2)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderRecentTable() {
  return `
    <div class="table-wrap">
      <table class="recent-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Category</th>
            <th scope="col">Value</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          ${state.recent.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-strong">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="table-truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${formatCurrency.format(item.value)}</td>
              <td data-label="Created">${formatLongDate.format(new Date(item.createdAt))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function toggleTheme() {
  const previousTheme = state.theme;
  const nextTheme = previousTheme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  try {
    await fetchJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: nextTheme })
    });
  } catch (error) {
    console.error(error);
    applyTheme(previousTheme);
    alert('Could not persist theme preference. Please try again.');
  }
}

function setupChartResize() {
  const shell = document.querySelector('#chartShell');
  if (!shell) return;
  state.chartObserver = new ResizeObserver(() => drawChart());
  state.chartObserver.observe(shell);
}

function drawChart() {
  const svg = document.querySelector('#timeseriesChart');
  const shell = document.querySelector('#chartShell');
  if (!svg || !shell || !state.timeseries.length) return;

  const rect = shell.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const isSmall = width < 430;
  const margin = {
    top: 18,
    right: isSmall ? 14 : 22,
    bottom: isSmall ? 46 : 44,
    left: isSmall ? 44 : 58
  };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);

  const values = state.timeseries.map((point) => point.visitors);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  const padding = Math.max(100, (maxRaw - minRaw) * 0.12);
  const min = Math.max(0, Math.floor((minRaw - padding) / 100) * 100);
  const max = Math.ceil((maxRaw + padding) / 100) * 100;
  const range = max - min || 1;

  const xFor = (index) => margin.left + (index / (state.timeseries.length - 1)) * plotWidth;
  const yFor = (value) => margin.top + (1 - (value - min) / range) * plotHeight;
  const linePath = state.timeseries
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index).toFixed(2)} ${yFor(point.visitors).toFixed(2)}`)
    .join(' ');

  const yTicks = 4;
  const tickEls = [];
  for (let i = 0; i <= yTicks; i += 1) {
    const value = min + (range * i) / yTicks;
    const y = yFor(value);
    tickEls.push(`
      <line class="grid-line" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
      <text class="axis-label y-label" x="${margin.left - 8}" y="${y + 4}" text-anchor="end">${formatAxis(value)}</text>
    `);
  }

  const xTickCount = isSmall ? 3 : 5;
  for (let i = 0; i < xTickCount; i += 1) {
    const index = Math.round((i / (xTickCount - 1)) * (state.timeseries.length - 1));
    const x = xFor(index);
    const label = formatDate.format(new Date(`${state.timeseries[index].date}T00:00:00`));
    tickEls.push(`
      <line class="tick-line" x1="${x}" y1="${margin.top + plotHeight}" x2="${x}" y2="${margin.top + plotHeight + 5}"></line>
      <text class="axis-label x-label" x="${x}" y="${height - 16}" text-anchor="middle">${label}</text>
    `);
  }

  const points = state.timeseries.map((point, index) =>
    `<circle class="data-dot" cx="${xFor(index).toFixed(2)}" cy="${yFor(point.visitors).toFixed(2)}" r="${isSmall ? 2 : 2.7}"><title>${formatLongDate.format(new Date(`${point.date}T00:00:00`))}: ${formatInteger.format(point.visitors)} visitors</title></circle>`
  ).join('');

  svg.innerHTML = `
    <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}" rx="16"></rect>
    <g class="chart-grid">${tickEls.join('')}</g>
    <line class="axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}"></line>
    <line class="axis-line" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${width - margin.right}" y2="${margin.top + plotHeight}"></line>
    <path class="series-area" d="${linePath} L ${width - margin.right} ${margin.top + plotHeight} L ${margin.left} ${margin.top + plotHeight} Z"></path>
    <path class="series-line" d="${linePath}"></path>
    <g>${points}</g>
  `;
}

function formatAxis(value) {
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

loadDashboard();
