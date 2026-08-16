const API = window.METRICS_API_URL || window.location.origin;
const app = document.querySelector('#app');

const fmtInt = new Intl.NumberFormat('en-US');
const fmtCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtShortCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtUTCDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

let state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  chartObserver: null,
  resizeHandler: null
};

init();

async function init() {
  renderShell();
  try {
    const settings = await fetchJson('/api/settings');
    applyTheme(settings.theme || 'light');
    await loadDashboard();
    wireThemeToggle();
  } catch (error) {
    console.error(error);
    renderError(error);
  } finally {
    document.documentElement.classList.remove('theme-loading');
  }
}

async function loadDashboard() {
  const [summary, timeseries, categories, recent] = await Promise.all([
    fetchJson('/api/summary'),
    fetchJson('/api/timeseries'),
    fetchJson('/api/categories'),
    fetchJson('/api/recent')
  ]);
  state = { ...state, summary, timeseries, categories, recent };
  renderDashboard();
}

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Unable to load ${path} (${res.status})`);
  return res.json();
}

function renderShell() {
  app.innerHTML = `
    <div class="page">
      <header class="topbar">
        <div class="title-wrap">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" type="button" aria-label="Toggle dark theme" disabled>
          <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
          <span class="toggle-text">Theme</span>
        </button>
      </header>
      <main id="content" class="content" aria-live="polite">
        <section class="panel loading-panel">
          <div class="spinner" aria-hidden="true"></div>
          <p>Loading dashboard data from the API…</p>
        </section>
      </main>
    </div>
  `;
}

function renderError(error) {
  const content = document.querySelector('#content');
  if (!content) return;
  content.innerHTML = `
    <section class="panel error-state" role="alert">
      <div class="error-icon">!</div>
      <div>
        <h2>Dashboard data unavailable</h2>
        <p>The dashboard renders only from live API data. Start the backend and reload the page.</p>
        <p class="error-detail">${escapeHtml(error.message)}</p>
      </div>
    </section>
  `;
}

function renderDashboard() {
  const content = document.querySelector('#content');
  content.innerHTML = `
    <section class="stats-grid" aria-label="Summary metrics">
      ${statCard('Total visitors', fmtInt.format(state.summary.totalVisitors), 'All visits across the seeded 30-day period', 'Visitors')}
      ${statCard('Total revenue', fmtCurrency.format(state.summary.totalRevenue), 'Gross revenue for the seeded 30 days', 'Revenue')}
      ${statCard('Best day', fmtUTCDate.format(new Date(`${state.summary.bestDay.date}T00:00:00Z`)), `${fmtCurrency.format(state.summary.bestDay.revenue)} revenue`, 'Peak')}
      ${statCard('7-day trend', `${state.summary.sevenDayTrendPct >= 0 ? '+' : ''}${state.summary.sevenDayTrendPct}%`, 'Latest 7 days vs. previous 7', state.summary.sevenDayTrendPct >= 0 ? 'Up' : 'Down')}
    </section>

    <section class="body-grid">
      <article class="panel chart-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">30-day series</p>
            <h2>Visitors over time</h2>
          </div>
          <span class="legend-chip"><span></span> Visitors</span>
        </div>
        <div id="lineChart" class="chart-box" aria-label="30 day visitors line chart"></div>
      </article>

      <article class="panel category-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Breakdown</p>
            <h2>Category value</h2>
          </div>
        </div>
        <div class="bars">
          ${state.categories.map(categoryBar).join('')}
        </div>
      </article>
    </section>

    <section class="panel table-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Latest activity</p>
          <h2>Recent items</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
          <tbody>${state.recent.map(tableRow).join('')}</tbody>
        </table>
      </div>
    </section>
  `;

  document.querySelector('.theme-toggle').disabled = false;
  drawChart();
  attachResizeObservers();
}

function statCard(label, value, note, badge) {
  return `
    <article class="stat-card">
      <div class="stat-top"><span>${escapeHtml(label)}</span><b>${escapeHtml(badge)}</b></div>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <p>${escapeHtml(note)}</p>
    </article>
  `;
}

function categoryBar(cat) {
  const max = Math.max(...state.categories.map(c => c.value));
  const pct = Math.max(4, (cat.value / max) * 100);
  return `
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label" title="${escapeHtml(cat.label)}">${escapeHtml(cat.label)}</span>
        <span class="bar-value">${fmtCurrency.format(cat.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

function tableRow(item) {
  return `
    <tr>
      <td data-label="Name"><span class="cell-title">${escapeHtml(item.name)}</span></td>
      <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
      <td data-label="Value">${fmtCurrency.format(item.value)}</td>
      <td data-label="Created">${fmtUTCDate.format(new Date(item.createdAt))}</td>
    </tr>
  `;
}

function attachResizeObservers() {
  if (state.chartObserver) state.chartObserver.disconnect();
  const chart = document.querySelector('#lineChart');
  if ('ResizeObserver' in window && chart) {
    state.chartObserver = new ResizeObserver(() => drawChart());
    state.chartObserver.observe(chart);
  } else {
    if (state.resizeHandler) window.removeEventListener('resize', state.resizeHandler);
    state.resizeHandler = () => drawChart();
    window.addEventListener('resize', state.resizeHandler);
  }
}

function drawChart() {
  const box = document.querySelector('#lineChart');
  if (!box || !state.timeseries.length) return;
  const width = Math.max(280, Math.floor(box.clientWidth));
  const height = Math.max(260, Math.floor(box.clientHeight || 320));
  const compact = width < 460;
  const margin = compact
    ? { top: 18, right: 12, bottom: 44, left: 48 }
    : { top: 20, right: 22, bottom: 52, left: 62 };
  const innerW = Math.max(10, width - margin.left - margin.right);
  const innerH = Math.max(10, height - margin.top - margin.bottom);
  const values = state.timeseries.map(d => d.visitors);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  const pad = Math.max(100, (maxRaw - minRaw) * 0.12);
  const min = Math.floor((minRaw - pad) / 100) * 100;
  const max = Math.ceil((maxRaw + pad) / 100) * 100;
  const x = i => margin.left + (state.timeseries.length === 1 ? 0 : (i / (state.timeseries.length - 1)) * innerW);
  const y = v => margin.top + (1 - (v - min) / (max - min || 1)) * innerH;
  const path = state.timeseries.map((d, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(d.visitors).toFixed(1)}`).join(' ');
  const baseY = margin.top + innerH - 1;
  const area = `${path} L ${margin.left + innerW} ${baseY} L ${margin.left} ${baseY} Z`;
  const yTicks = 4;
  const yGrid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = min + ((max - min) / yTicks) * i;
    const yy = y(val);
    return `<g><line class="grid" x1="${margin.left}" y1="${yy}" x2="${margin.left + innerW}" y2="${yy}"/><text class="axis-label" x="${margin.left - 8}" y="${yy + 4}" text-anchor="end">${fmtInt.format(Math.round(val))}</text></g>`;
  }).join('');
  const xIndices = compact ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const xTicks = xIndices.map(i => {
    const xx = x(i);
    const label = fmtUTCDate.format(new Date(`${state.timeseries[i].date}T00:00:00Z`));
    return `<g><line class="tick" x1="${xx}" y1="${margin.top + innerH}" x2="${xx}" y2="${margin.top + innerH + 6}"/><text class="axis-label" x="${xx}" y="${margin.top + innerH + 25}" text-anchor="middle">${label}</text></g>`;
  }).join('');
  const points = state.timeseries.map((d, i) => `<circle class="point" cx="${x(i)}" cy="${y(d.visitors)}" r="${compact ? 2.2 : 3}"/>`).join('');

  box.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-labelledby="chartTitle chartDesc" preserveAspectRatio="none">
      <title id="chartTitle">Visitors over the last 30 days</title>
      <desc id="chartDesc">Line chart with values from ${fmtInt.format(minRaw)} to ${fmtInt.format(maxRaw)} visitors.</desc>
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}" rx="16"/>
      ${yGrid}
      <line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}"/>
      <line class="axis" x1="${margin.left}" y1="${margin.top + innerH}" x2="${margin.left + innerW}" y2="${margin.top + innerH}"/>
      ${xTicks}
      <clipPath id="plotClip"><rect x="${margin.left}" y="${margin.top}" width="${innerW}" height="${innerH}"/></clipPath>
      <g clip-path="url(#plotClip)">
        <path class="area" d="${area}"/>
        <path class="series" d="${path}"/>
        ${points}
      </g>
    </svg>
  `;
}

function wireThemeToggle() {
  const btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    btn.disabled = true;
    try {
      await fetch(`${API}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next })
      });
    } catch (error) {
      console.error(error);
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      alert('Unable to save theme preference.');
    } finally {
      btn.disabled = false;
    }
  });
}

function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  state.theme = normalized;
  document.documentElement.dataset.theme = normalized;
  const btn = document.querySelector('.theme-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', normalized === 'dark' ? 'true' : 'false');
    btn.querySelector('.toggle-text').textContent = normalized === 'dark' ? 'Dark' : 'Light';
  }
  drawChart();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
