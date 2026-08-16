import './styles.css';

const app = document.querySelector('#app');
const API = '';
const numberFmt = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const shortDateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const longDateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  chartResizeObserver: null
};

function parseApiDate(value) {
  if (!value) return new Date();
  const clean = String(value).slice(0, 10);
  return new Date(`${clean}T00:00:00Z`);
}

async function jsonFetch(url, options) {
  const response = await fetch(`${API}${url}`, options);
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', state.theme === 'dark' ? 'dark light' : 'light dark');
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.checked = state.theme === 'dark';
    toggle.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
  }
  drawChart();
}

async function loadDashboard() {
  try {
    const settings = await jsonFetch('/api/settings');
    applyTheme(settings.theme);
    const [summary, timeseries, categories, recent] = await Promise.all([
      jsonFetch('/api/summary'),
      jsonFetch('/api/timeseries'),
      jsonFetch('/api/categories'),
      jsonFetch('/api/recent')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    renderDashboard();
  } catch (error) {
    renderError(error);
  }
}

function statCard(label, value, meta, modifier = '') {
  return `
    <section class="card stat-card ${modifier}">
      <p class="card-label">${label}</p>
      <strong class="stat-value">${value}</strong>
      <span class="stat-meta">${meta}</span>
    </section>`;
}

function renderDashboard() {
  const summary = state.summary;
  const trendClass = summary.sevenDayTrend >= 0 ? 'positive' : 'negative';
  const trendSymbol = summary.sevenDayTrend >= 0 ? '▲' : '▼';
  app.innerHTML = `
    <div class="dashboard-shell">
      <header class="topbar">
        <div class="title-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Deterministic PGLite data rendered by responsive vanilla JavaScript.</p>
        </div>
        <label class="theme-switch">
          <span>Light</span>
          <input id="themeToggle" type="checkbox" role="switch" ${state.theme === 'dark' ? 'checked' : ''} />
          <span class="slider" aria-hidden="true"></span>
          <span>Dark</span>
        </label>
      </header>

      <main>
        <section class="stats-grid" aria-label="Summary metrics">
          ${statCard('Total visitors', numberFmt.format(summary.totalVisitors), '30-day cumulative traffic')}
          ${statCard('Total revenue', currencyFmt.format(summary.totalRevenue), '30-day recognized revenue', 'wide-number')}
          ${statCard('Best day', numberFmt.format(summary.bestDay.visitors), `${longDateFmt.format(parseApiDate(summary.bestDay.day))} visitors`)}
          ${statCard('7-day trend', `${trendSymbol} ${Math.abs(summary.sevenDayTrend).toFixed(1)}%`, 'Visitors vs previous 7 days', trendClass)}
        </section>

        <section class="content-grid">
          <article class="card chart-card">
            <div class="card-heading">
              <div>
                <p class="card-label">Traffic over time</p>
                <h2>30-day visitor trend</h2>
              </div>
              <span class="legend-dot">Visitors</span>
            </div>
            <div id="chartWrap" class="chart-wrap" aria-label="30 day visitor line chart"></div>
          </article>

          <article class="card bars-card">
            <div class="card-heading">
              <div>
                <p class="card-label">Breakdown</p>
                <h2>Category value</h2>
              </div>
            </div>
            <div class="bars-list">
              ${state.categories.map(categoryBar).join('')}
            </div>
          </article>
        </section>

        <section class="card table-card">
          <div class="card-heading">
            <div>
              <p class="card-label">Activity</p>
              <h2>Recent items</h2>
            </div>
            <span class="table-count">${state.recent.length} rows</span>
          </div>
          <div class="table-scroll" tabindex="0">
            <table>
              <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
              <tbody>
                ${state.recent.map((item) => `
                  <tr>
                    <td data-label="Name"><span class="cell-title">${escapeHtml(item.name)}</span></td>
                    <td data-label="Category"><span class="truncate-cell">${escapeHtml(item.category)}</span></td>
                    <td data-label="Value">${currencyFmt.format(item.value)}</td>
                    <td data-label="Created">${longDateFmt.format(new Date(item.created_at))}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>`;

  bindEvents();
  setupChartObserver();
  drawChart();
}

function categoryBar(category) {
  const max = Math.max(...state.categories.map((c) => c.value));
  const pct = max ? Math.max(5, (category.value / max) * 100) : 0;
  return `
    <div class="bar-row">
      <div class="bar-topline">
        <span class="bar-label" title="${escapeHtml(category.label)}">${escapeHtml(category.label)}</span>
        <strong class="bar-value">${currencyFmt.format(category.value)}</strong>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width: ${pct}%"></div></div>
    </div>`;
}

function bindEvents() {
  document.querySelector('#themeToggle')?.addEventListener('change', async (event) => {
    const next = event.target.checked ? 'dark' : 'light';
    applyTheme(next);
    try {
      await jsonFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next })
      });
    } catch (error) {
      renderToast(`Theme could not be saved: ${error.message}`);
    }
  });
}

function setupChartObserver() {
  if (state.chartResizeObserver) state.chartResizeObserver.disconnect();
  const wrap = document.querySelector('#chartWrap');
  if (!wrap) return;
  state.chartResizeObserver = new ResizeObserver(() => drawChart());
  state.chartResizeObserver.observe(wrap);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart() {
  const wrap = document.querySelector('#chartWrap');
  if (!wrap || !state.timeseries.length) return;

  const width = Math.max(260, Math.floor(wrap.clientWidth));
  const height = Math.max(260, Math.floor(wrap.clientHeight || 320));
  const compact = width < 430;
  const margin = compact ? { top: 22, right: 16, bottom: 46, left: 48 } : { top: 22, right: 24, bottom: 48, left: 64 };
  const innerW = Math.max(100, width - margin.left - margin.right);
  const innerH = Math.max(100, height - margin.top - margin.bottom);
  const values = state.timeseries.map((d) => Number(d.visitors));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(800, (max - min) * 0.12);
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const x = (i) => margin.left + (state.timeseries.length === 1 ? 0 : (i / (state.timeseries.length - 1)) * innerW);
  const y = (v) => margin.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  const points = state.timeseries.map((d, i) => `${x(i).toFixed(1)},${y(Number(d.visitors)).toFixed(1)}`).join(' ');
  const areaPoints = `${margin.left},${margin.top + innerH} ${points} ${margin.left + innerW},${margin.top + innerH}`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + (yMax - yMin) * t);
  const xTickIndexes = compact ? [0, 10, 20, 29] : [0, 7, 14, 21, 29];
  const grid = cssVar('--chart-grid');
  const axis = cssVar('--chart-axis');
  const text = cssVar('--muted');
  const series = cssVar('--accent');
  const area = cssVar('--accent-soft');

  wrap.innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="Line chart of visitors for 30 days" preserveAspectRatio="xMidYMid meet">
      <rect width="${width}" height="${height}" fill="transparent"></rect>
      ${yTicks.map((tick) => {
        const ty = y(tick);
        return `<line x1="${margin.left}" x2="${margin.left + innerW}" y1="${ty}" y2="${ty}" stroke="${grid}" stroke-width="1" />
                <text x="${margin.left - 8}" y="${ty + 4}" text-anchor="end" fill="${text}" font-size="11">${compactFmt.format(tick)}</text>`;
      }).join('')}
      <line x1="${margin.left}" x2="${margin.left + innerW}" y1="${margin.top + innerH}" y2="${margin.top + innerH}" stroke="${axis}" />
      <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + innerH}" stroke="${axis}" />
      ${xTickIndexes.map((idx) => {
        const tx = x(idx);
        const anchor = idx === 0 ? 'start' : idx === 29 ? 'end' : 'middle';
        return `<line x1="${tx}" x2="${tx}" y1="${margin.top + innerH}" y2="${margin.top + innerH + 5}" stroke="${axis}" />
                <text x="${tx}" y="${height - 18}" text-anchor="${anchor}" fill="${text}" font-size="11">${shortDateFmt.format(parseApiDate(state.timeseries[idx].date))}</text>`;
      }).join('')}
      <polygon points="${areaPoints}" fill="${area}" opacity="0.9"></polygon>
      <polyline points="${points}" fill="none" stroke="${series}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${state.timeseries.map((d, i) => `<circle cx="${x(i)}" cy="${y(Number(d.visitors))}" r="${compact ? 2.2 : 2.8}" fill="${series}" />`).join('')}
    </svg>`;
}

function renderError(error) {
  app.innerHTML = `
    <main class="error-state">
      <section class="card error-card">
        <p class="eyebrow">Dashboard unavailable</p>
        <h1>Metrics could not be loaded</h1>
        <p>The page renders only from API data. Start the backend server and reload to view the dashboard.</p>
        <pre>${escapeHtml(error.message)}</pre>
        <button id="retryButton" type="button">Retry</button>
      </section>
    </main>`;
  document.querySelector('#retryButton')?.addEventListener('click', loadDashboard);
}

function renderToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

loadDashboard();
