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

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat('en-US');
const shortMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const shortInt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function loadThemeBeforePaint() {
  try {
    const settings = await api('/api/settings');
    state.theme = settings.theme === 'dark' ? 'dark' : 'light';
  } catch (error) {
    state.theme = 'light';
  }
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.visibility = 'visible';
}

function shell(inner) {
  app.innerHTML = `
    <div class="page-shell">
      <header class="topbar">
        <div class="brand-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" type="button" aria-pressed="${state.theme === 'dark'}" aria-label="Toggle dark theme">
          <span class="toggle-track"><span class="toggle-dot"></span></span>
          <span class="toggle-text">${state.theme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
      </header>
      ${inner}
    </div>`;
  app.querySelector('.theme-toggle')?.addEventListener('click', toggleTheme);
}

function loading() {
  shell(`<main class="status-card" role="status"><div class="spinner"></div><p>Loading metrics from the API…</p></main>`);
}

function errorView(message) {
  shell(`
    <main class="status-card error-state" role="alert">
      <h2>Dashboard data is unavailable</h2>
      <p>${escapeHtml(message)}</p>
      <p class="muted">Start the backend server and reload. No hardcoded dashboard data is shown when the API cannot be reached.</p>
      <button class="retry" type="button">Retry</button>
    </main>`);
  app.querySelector('.retry')?.addEventListener('click', init);
}

function render() {
  const bestDate = new Date(`${state.summary.bestDay.day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const trend = state.summary.sevenDayTrendPercent;
  const positive = trend >= 0;

  shell(`
    <main class="dashboard-grid">
      <section class="stat-card" aria-label="Total visitors">
        <span class="card-label">Total visitors</span>
        <strong class="stat-value fit-number">${integer.format(state.summary.totalVisitors)}</strong>
        <span class="stat-note ${positive ? 'up' : 'down'}">${positive ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}% 7-day trend</span>
      </section>
      <section class="stat-card" aria-label="Total revenue">
        <span class="card-label">Total revenue</span>
        <strong class="stat-value fit-number">${money.format(state.summary.totalRevenue)}</strong>
        <span class="stat-note">Seeded 30-day total</span>
      </section>
      <section class="stat-card" aria-label="Best revenue day">
        <span class="card-label">Best day</span>
        <strong class="stat-value">${bestDate}</strong>
        <span class="stat-note">${money.format(state.summary.bestDay.revenue)} revenue</span>
      </section>
      <section class="stat-card" aria-label="Largest category value">
        <span class="card-label">Largest category</span>
        <strong class="stat-value fit-number">${integer.format(Math.max(...state.categories.map(c => c.value)))}</strong>
        <span class="stat-note truncate">${escapeHtml(state.categories[0]?.label || '')}</span>
      </section>

      <section class="panel chart-panel">
        <div class="panel-head">
          <div>
            <h2>30-day visitor trend</h2>
            <p class="muted">Hand-drawn SVG, resized to its card.</p>
          </div>
        </div>
        <div id="lineChart" class="chart-box" aria-label="30 day line chart"></div>
      </section>

      <section class="panel category-panel">
        <div class="panel-head"><h2>Category breakdown</h2></div>
        <div class="bars">
          ${state.categories.map(categoryBar).join('')}
        </div>
      </section>

      <section class="panel table-panel">
        <div class="panel-head"><h2>Recent items</h2></div>
        <div class="responsive-table" role="region" aria-label="Recent items table">
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
            <tbody>
              ${state.recent.map(row => `
                <tr>
                  <td data-label="Name"><span class="cell-main">${escapeHtml(row.name)}</span></td>
                  <td data-label="Category"><span class="pill truncate">${escapeHtml(row.category)}</span></td>
                  <td data-label="Value">${money.format(row.value)}</td>
                  <td data-label="Created">${new Date(row.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </main>`);

  setupChartResize();
  drawLineChart();
}

function categoryBar(category) {
  const max = Math.max(...state.categories.map(c => c.value));
  const pct = Math.max(7, (category.value / max) * 100);
  return `
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label truncate" title="${escapeHtml(category.label)}">${escapeHtml(category.label)}</span>
        <span class="bar-value">${integer.format(category.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
}

function setupChartResize() {
  if (state.resizeObserver) state.resizeObserver.disconnect();
  const box = document.querySelector('#lineChart');
  if (!box) return;
  state.resizeObserver = new ResizeObserver(() => drawLineChart());
  state.resizeObserver.observe(box);
}

function themeVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawLineChart() {
  const container = document.querySelector('#lineChart');
  if (!container || !state.timeseries.length) return;

  const width = Math.max(280, Math.floor(container.clientWidth));
  const height = Math.max(260, Math.floor(container.clientHeight || 300));
  const compact = width < 430;
  const margin = { top: 18, right: compact ? 12 : 24, bottom: compact ? 58 : 46, left: compact ? 48 : 62 };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = Math.max(10, height - margin.top - margin.bottom);
  const values = state.timeseries.map(d => d.visitors);
  const min = Math.floor(Math.min(...values) / 500) * 500;
  const max = Math.ceil(Math.max(...values) / 500) * 500;
  const x = i => margin.left + (i / (values.length - 1)) * plotW;
  const y = v => margin.top + (1 - ((v - min) / (max - min || 1))) * plotH;
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const yTicks = [min, min + (max - min) / 2, max];
  const xTickIdx = compact ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const axis = themeVar('--axis');
  const grid = themeVar('--grid');
  const text = themeVar('--muted');
  const series = themeVar('--series');
  const fill = themeVar('--series-fill');

  container.innerHTML = `
    <svg class="line-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chartTitle chartDesc">
      <title id="chartTitle">30-day visitors line chart</title>
      <desc id="chartDesc">Visitor counts from ${state.timeseries[0].date} through ${state.timeseries.at(-1).date}</desc>
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
      ${yTicks.map(t => `
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(t)}" y2="${y(t)}" stroke="${grid}" stroke-width="1" />
        <text x="${margin.left - 8}" y="${y(t) + 4}" text-anchor="end" class="chart-label" fill="${text}">${shortInt.format(t)}</text>`).join('')}
      <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="${axis}" />
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="${axis}" />
      <polygon points="${margin.left},${height - margin.bottom} ${points} ${width - margin.right},${height - margin.bottom}" fill="${fill}" opacity="0.7" />
      <polyline points="${points}" fill="none" stroke="${series}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${values.map((v, i) => i % 3 === 0 || i === values.length - 1 ? `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${series}" />` : '').join('')}
      ${xTickIdx.map(i => {
        const d = new Date(`${state.timeseries[i].date}T00:00:00`);
        const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const rotate = compact ? ` transform="rotate(-35 ${x(i)} ${height - margin.bottom + 24})"` : '';
        return `<line x1="${x(i)}" x2="${x(i)}" y1="${height - margin.bottom}" y2="${height - margin.bottom + 5}" stroke="${axis}" />
          <text x="${x(i)}" y="${height - margin.bottom + 24}" text-anchor="${compact ? 'end' : 'middle'}" class="chart-label" fill="${text}"${rotate}>${label}</text>`;
      }).join('')}
      <text x="${margin.left}" y="${height - 12}" class="chart-caption" fill="${text}">Visitors</text>
    </svg>`;
}

async function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  const previous = state.theme;
  applyTheme(next);
  try {
    const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
    applyTheme(saved.theme);
  } catch (error) {
    applyTheme(previous);
    alert('Could not save theme preference. Please try again.');
  }
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
    toggle.querySelector('.toggle-text').textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  }
  drawLineChart();
}

async function init() {
  loading();
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'), api('/api/timeseries'), api('/api/categories'), api('/api/recent')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    render();
  } catch (error) {
    console.error(error);
    errorView('The dashboard could not fetch JSON from the metrics API.');
  }
}

loadThemeBeforePaint().then(init);
