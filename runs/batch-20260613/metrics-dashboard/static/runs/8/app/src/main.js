import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || (location.port === '3000' ? '' : 'http://localhost:3000');
const app = document.querySelector('#app');

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: document.documentElement.dataset.theme || 'light',
  chartObserver: null
};

const fmtInt = new Intl.NumberFormat('en-US');
const fmtCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  try { sessionStorage.setItem('dashboard-theme', state.theme); } catch (e) {}
  const pressed = state.theme === 'dark';
  const btn = document.querySelector('#theme-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(pressed));
    btn.textContent = pressed ? '☀️ Light mode' : '🌙 Dark mode';
  }
  drawChart();
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json();
}

async function init() {
  try {
    const settings = await api('/api/settings');
    applyTheme(settings.theme);
    app.innerHTML = skeleton();
    bindThemeToggle();
    applyTheme(settings.theme);

    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'), api('/api/timeseries'), api('/api/categories'), api('/api/recent')
    ]);
    Object.assign(state, { summary, timeseries, categories, recent });
    renderDashboard();
  } catch (error) {
    console.error(error);
    app.innerHTML = skeleton();
    bindThemeToggle();
    applyTheme(state.theme);
    renderError(error);
  }
}

function skeleton() {
  return `
    <header class="topbar">
      <div class="brand-block">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
      </div>
      <button id="theme-toggle" class="theme-toggle" type="button" aria-pressed="false">🌙 Dark mode</button>
    </header>
    <main id="dashboard" class="dashboard" aria-live="polite">
      <section class="loading card">Loading dashboard data…</section>
    </main>
  `;
}

function bindThemeToggle() {
  document.querySelector('#theme-toggle')?.addEventListener('click', async () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
    } catch (error) {
      console.error(error);
      const dashboard = document.querySelector('#dashboard');
      const note = document.createElement('div');
      note.className = 'toast';
      note.textContent = 'Theme changed locally, but could not be saved to the server.';
      dashboard?.prepend(note);
      setTimeout(() => note.remove(), 5000);
    }
  });
}

function renderError(error) {
  const dashboard = document.querySelector('#dashboard');
  dashboard.innerHTML = `
    <section class="error-state card">
      <h2>Dashboard data unavailable</h2>
      <p>The page renders only from the metrics API. Start the backend server and refresh to load the dashboard.</p>
      <code>${escapeHtml(error.message)}</code>
    </section>
  `;
}

function renderDashboard() {
  const dashboard = document.querySelector('#dashboard');
  const summary = state.summary;
  const bestDate = summary.bestDay ? fmtDate.format(new Date(`${summary.bestDay.date}T00:00:00Z`)) : '—';
  const trendPositive = summary.sevenDayTrendPct >= 0;

  dashboard.innerHTML = `
    <section class="stats-grid" aria-label="Summary metrics">
      ${statCard('Total visitors', fmtInt.format(summary.totalVisitors), '30-day traffic', '↗ deterministic seed')}
      ${statCard('Total revenue', fmtCurrency.format(summary.totalRevenue), '30-day gross revenue', 'large value test')}
      ${statCard('Best day', bestDate, summary.bestDay ? fmtCurrency.format(summary.bestDay.revenue) : 'No data', 'highest revenue')}
      ${statCard('7-day trend', `${trendPositive ? '+' : ''}${summary.sevenDayTrendPct.toFixed(2)}%`, 'vs previous 7 days', trendPositive ? '↗ improving' : '↘ declining')}
    </section>

    <section class="body-grid">
      <article class="card chart-card">
        <div class="card-heading">
          <div>
            <p class="eyebrow">30 day series</p>
            <h2>Visitors over time</h2>
          </div>
          <span class="muted">SVG redraws on resize</span>
        </div>
        <div id="chart-wrap" class="chart-wrap"></div>
      </article>

      <article class="card breakdown-card">
        <div class="card-heading">
          <div>
            <p class="eyebrow">Category mix</p>
            <h2>Breakdown</h2>
          </div>
        </div>
        <div class="bars" role="list">
          ${state.categories.map(categoryRow).join('')}
        </div>
      </article>

      <article class="card table-card">
        <div class="card-heading">
          <div>
            <p class="eyebrow">Latest events</p>
            <h2>Recent items</h2>
          </div>
        </div>
        ${recentTable()}
      </article>
    </section>
  `;

  installChartObserver();
  drawChart();
}

function statCard(label, value, meta, trend) {
  return `
    <article class="stat-card card">
      <p class="stat-label">${escapeHtml(label)}</p>
      <strong class="stat-value" title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
      <div class="stat-footer"><span>${escapeHtml(meta)}</span><span>${escapeHtml(trend)}</span></div>
    </article>
  `;
}

function categoryRow(cat) {
  const max = Math.max(...state.categories.map((c) => c.value), 1);
  const pct = Math.max(5, (cat.value / max) * 100);
  return `
    <div class="bar-row" role="listitem">
      <div class="bar-label" title="${escapeHtml(cat.label)}">${escapeHtml(cat.label)}</div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${pct.toFixed(2)}%"></div></div>
      <div class="bar-value">${fmtInt.format(cat.value)}</div>
    </div>
  `;
}

function recentTable() {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
        <tbody>
          ${state.recent.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-main">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${fmtInt.format(item.value)}</td>
              <td data-label="Created">${fmtDate.format(new Date(item.created_at))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function installChartObserver() {
  state.chartObserver?.disconnect();
  const target = document.querySelector('#chart-wrap');
  if (!target) return;
  state.chartObserver = new ResizeObserver(() => drawChart());
  state.chartObserver.observe(target);
  window.addEventListener('resize', drawChart, { passive: true });
}

function drawChart() {
  const wrap = document.querySelector('#chart-wrap');
  if (!wrap || !state.timeseries.length) return;

  const rect = wrap.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(240, Math.floor(rect.height || 320));
  const small = width < 460;
  const margin = { top: 18, right: small ? 16 : 24, bottom: 42, left: small ? 46 : 58 };
  const plotW = Math.max(1, width - margin.left - margin.right);
  const plotH = Math.max(1, height - margin.top - margin.bottom);
  const values = state.timeseries.map((d) => d.visitors);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  const pad = Math.max(100, (maxRaw - minRaw) * 0.12);
  const min = Math.floor((minRaw - pad) / 1000) * 1000;
  const max = Math.ceil((maxRaw + pad) / 1000) * 1000;
  const x = (i) => margin.left + (i / (state.timeseries.length - 1)) * plotW;
  const y = (v) => margin.top + (1 - (v - min) / (max - min)) * plotH;
  const points = state.timeseries.map((d, i) => `${x(i).toFixed(2)},${y(d.visitors).toFixed(2)}`).join(' ');
  const yTicks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
  const xIndexes = small ? [0, 14, 29] : [0, 7, 14, 21, 29];

  wrap.innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="30 day visitor line chart">
      <rect x="0" y="0" width="${width}" height="${height}" rx="16" class="chart-bg"></rect>
      ${yTicks.map((tick) => {
        const yy = y(tick);
        return `<line x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}" class="grid-line" />
          <text x="${margin.left - 8}" y="${yy + 4}" text-anchor="end" class="axis-text">${formatCompact(tick)}</text>`;
      }).join('')}
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="axis-line" />
      <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="axis-line" />
      ${xIndexes.map((idx) => {
        const xx = x(idx);
        const d = state.timeseries[idx];
        return `<line x1="${xx}" y1="${height - margin.bottom}" x2="${xx}" y2="${height - margin.bottom + 5}" class="axis-line" />
          <text x="${xx}" y="${height - 15}" text-anchor="middle" class="axis-text">${fmtDate.format(new Date(`${d.date}T00:00:00Z`))}</text>`;
      }).join('')}
      <polyline points="${points}" fill="none" class="series-line" />
      ${state.timeseries.map((d, i) => `<circle cx="${x(i).toFixed(2)}" cy="${y(d.visitors).toFixed(2)}" r="${small ? 2.1 : 2.8}" class="series-point" />`).join('')}
    </svg>
  `;
}

function formatCompact(value) {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

init();
