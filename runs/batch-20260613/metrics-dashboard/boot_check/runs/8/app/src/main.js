import './styles.css';

const app = document.querySelector('#app');

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  settings: { theme: document.documentElement.dataset.theme || 'light' },
  chartObserver: null
};

const fmtInt = new Intl.NumberFormat('en-US');
const fmtMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const shortMoney = new Intl.NumberFormat('en-US', { notation: 'compact', style: 'currency', currency: 'USD', maximumFractionDigits: 1 });

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

async function api(path, options) {
  const res = await fetch(path, { cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.json();
}

function baseMarkup() {
  app.innerHTML = `
    <div class="page-shell">
      <header class="app-header">
        <div class="title-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Deterministically seeded from PGLite and redrawn for every viewport.</p>
        </div>
        <button class="theme-toggle" type="button" aria-pressed="${state.settings.theme === 'dark'}" aria-label="Toggle dark theme">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-text">${state.settings.theme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
      </header>
      <main id="content">
        <section class="loading-card" aria-live="polite">Loading dashboard data…</section>
      </main>
    </div>
  `;
  app.querySelector('.theme-toggle').addEventListener('click', toggleTheme);
}

function errorMarkup(message) {
  const content = app.querySelector('#content');
  content.innerHTML = `
    <section class="error-state" role="alert">
      <h2>Dashboard data unavailable</h2>
      <p>${escapeHtml(message || 'The API could not be reached. Start the backend server and reload the page.')}</p>
      <button type="button" class="retry">Retry</button>
    </section>
  `;
  content.querySelector('.retry').addEventListener('click', load);
}

function renderDashboard() {
  const content = app.querySelector('#content');
  content.innerHTML = `
    <section class="stats-grid" aria-label="Summary metrics">
      ${statCard('Total Visitors', fmtInt.format(state.summary.totalVisitors), `${trendText()} vs previous 7 days`, state.summary.sevenDayTrendPercent >= 0 ? 'positive' : 'negative')}
      ${statCard('Total Revenue', fmtMoney.format(state.summary.totalRevenue), '30-day seeded revenue', 'neutral')}
      ${statCard('Best Day', formatShortDate(state.summary.bestDay.date), `${fmtMoney.format(state.summary.bestDay.revenue)} revenue`, 'positive')}
      ${statCard('Largest Category', fmtMoney.format(Math.max(...state.categories.map(c => c.value))), state.categories.find(c => c.value === Math.max(...state.categories.map(x => x.value))).label, 'neutral')}
    </section>

    <section class="dashboard-grid">
      <article class="card chart-card">
        <div class="card-heading">
          <div><p class="eyebrow">30 days</p><h2>Visitor trend</h2></div>
          <span class="metric-pill">${fmtInt.format(state.timeseries.length)} points</span>
        </div>
        <div class="chart-wrap" id="timeseries-chart" aria-label="30-day visitor line chart" role="img"></div>
      </article>

      <article class="card categories-card">
        <div class="card-heading"><div><p class="eyebrow">Breakdown</p><h2>Category value</h2></div></div>
        <div class="bars" id="category-bars">
          ${renderBars()}
        </div>
      </article>

      <article class="card table-card">
        <div class="card-heading"><div><p class="eyebrow">Latest</p><h2>Recent items</h2></div></div>
        ${renderTable()}
      </article>
    </section>
  `;
  drawChart();
  attachResizeObserver();
}

function statCard(label, value, note, tone) {
  return `
    <article class="stat-card ${tone}">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
      <div class="stat-note">${escapeHtml(note)}</div>
    </article>
  `;
}

function trendText() {
  const v = state.summary.sevenDayTrendPercent;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function formatShortDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderBars() {
  const max = Math.max(...state.categories.map(c => c.value));
  return state.categories.map(c => `
    <div class="bar-row">
      <div class="bar-top">
        <span class="bar-label" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
        <span class="bar-value">${fmtMoney.format(c.value)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (c.value / max) * 100).toFixed(2)}%"></div></div>
    </div>
  `).join('');
}

function renderTable() {
  return `
    <div class="table-list" role="table" aria-label="Recent items">
      <div class="table-row table-head" role="row">
        <div role="columnheader">Item</div><div role="columnheader">Category</div><div role="columnheader">Value</div><div role="columnheader">Date</div>
      </div>
      ${state.recent.map(r => `
        <div class="table-row" role="row">
          <div class="item-name" role="cell" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div>
          <div class="item-category" role="cell" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</div>
          <div class="item-value" role="cell">${fmtMoney.format(r.value)}</div>
          <div role="cell">${formatShortDate(r.created_at.slice(0, 10))}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart() {
  const el = document.querySelector('#timeseries-chart');
  if (!el || !state.timeseries.length) return;
  const width = Math.max(280, Math.floor(el.clientWidth));
  const height = Math.max(260, Math.floor(el.clientHeight || 320));
  const small = width < 480;
  const m = { top: 18, right: small ? 12 : 22, bottom: small ? 42 : 48, left: small ? 42 : 58 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const vals = state.timeseries.map(d => d.visitors);
  const min = Math.floor(Math.min(...vals) * 0.94 / 100) * 100;
  const max = Math.ceil(Math.max(...vals) * 1.04 / 100) * 100;
  const x = (i) => m.left + (i / (state.timeseries.length - 1)) * innerW;
  const y = (v) => m.top + (1 - (v - min) / (max - min)) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round((min + (max - min) * t) / 100) * 100);
  const dateTickIdx = small ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const points = state.timeseries.map((d, i) => `${x(i).toFixed(1)},${y(d.visitors).toFixed(1)}`).join(' ');
  const grid = ticks.map(t => `<line x1="${m.left}" y1="${y(t)}" x2="${width - m.right}" y2="${y(t)}" class="grid"/><text x="${m.left - 8}" y="${y(t) + 4}" class="axis-label" text-anchor="end">${fmtInt.format(t)}</text>`).join('');
  const xLabels = dateTickIdx.map(i => `<line x1="${x(i)}" y1="${m.top}" x2="${x(i)}" y2="${height - m.bottom}" class="grid vertical"/><text x="${x(i)}" y="${height - 16}" class="axis-label" text-anchor="middle">${formatShortDate(state.timeseries[i].date)}</text>`).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="0" width="${width}" height="${height}" class="chart-bg"/>
      ${grid}
      ${xLabels}
      <line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${height - m.bottom}" class="axis"/>
      <line x1="${m.left}" y1="${height - m.bottom}" x2="${width - m.right}" y2="${height - m.bottom}" class="axis"/>
      <polyline points="${points}" fill="none" class="series"/>
      ${state.timeseries.map((d, i) => i % (small ? 6 : 4) === 0 || i === state.timeseries.length - 1 ? `<circle cx="${x(i)}" cy="${y(d.visitors)}" r="3" class="point"/>` : '').join('')}
    </svg>
  `;
}

function attachResizeObserver() {
  if (state.chartObserver) state.chartObserver.disconnect();
  const el = document.querySelector('#timeseries-chart');
  if (!el) return;
  state.chartObserver = new ResizeObserver(() => requestAnimationFrame(drawChart));
  state.chartObserver.observe(el);
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (err) {
    errorMarkup('Theme could not be saved. The dashboard data may be unavailable.');
  }
}

function applyTheme(theme) {
  state.settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  const btn = app.querySelector('.theme-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(theme === 'dark'));
    btn.querySelector('.toggle-text').textContent = theme === 'dark' ? 'Dark' : 'Light';
  }
  drawChart();
}

async function load() {
  baseMarkup();
  try {
    const settings = await api('/api/settings');
    applyTheme(settings.theme);
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'), api('/api/timeseries'), api('/api/categories'), api('/api/recent')
    ]);
    Object.assign(state, { summary, timeseries, categories, recent });
    renderDashboard();
  } catch (err) {
    console.error(err);
    errorMarkup('The dashboard renders only from live API data. Start the backend server and reload; no hardcoded metrics are shown.');
  }
}

load();
