import './styles.css';

const app = document.querySelector('#app');
let state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  settings: { theme: 'light' }
};
let chartResizeObserver;
let chartRender = () => {};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

async function loadDashboard() {
  try {
    const settings = await api('/api/settings');
    applyTheme(settings.theme, false);
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent')
    ]);
    state = { summary, timeseries, categories, recent, settings };
    render();
  } catch (error) {
    console.error(error);
    renderError(error);
  }
}

function applyTheme(theme, redraw = true) {
  const safe = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = safe;
  state.settings.theme = safe;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = safe;
  if (redraw) chartRender();
}

function renderError(error) {
  app.innerHTML = `
    <main class="shell error-shell">
      <section class="empty-card" role="alert">
        <div class="empty-icon">!</div>
        <h1>Dashboard data unavailable</h1>
        <p>The dashboard renders only from the metrics API. Start the backend server and reload this page.</p>
        <code>${escapeHtml(error.message || 'Network request failed')}</code>
        <button class="primary" id="retry">Retry</button>
      </section>
    </main>`;
  document.querySelector('#retry')?.addEventListener('click', loadDashboard);
}

function render() {
  const s = state.summary;
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand-block">
          <div class="eyebrow">Read-mostly analytics</div>
          <h1>Metrics Dashboard</h1>
          <p>30 days of deterministic product and revenue activity.</p>
        </div>
        <button class="theme-toggle" id="themeToggle" type="button" aria-pressed="${state.settings.theme === 'dark'}">
          <span class="toggle-dot"></span>
          <span class="toggle-label">${state.settings.theme === 'dark' ? 'Dark' : 'Light'} mode</span>
        </button>
      </header>

      <section class="stats-grid" aria-label="Summary metrics">
        ${statCard('Total visitors', number.format(s.totalVisitors), `${trendText(s.sevenDayTrend)} vs previous 7 days`, s.sevenDayTrend >= 0)}
        ${statCard('Total revenue', money.format(s.totalRevenue), 'Seeded 30-day revenue', true)}
        ${statCard('Best day', dateFmt.format(parseDate(s.bestDay.date)), `${number.format(s.bestDay.visitors)} visitors`, true)}
        ${statCard('7-day trend', `${s.sevenDayTrend >= 0 ? '+' : ''}${s.sevenDayTrend.toFixed(1)}%`, 'Visitor momentum', s.sevenDayTrend >= 0)}
      </section>

      <section class="body-grid">
        <article class="panel chart-panel">
          <div class="panel-heading">
            <div>
              <h2>30-day visitors</h2>
              <p>Hand-drawn responsive SVG chart</p>
            </div>
          </div>
          <div class="chart-wrap" id="visitorChart" aria-label="Line chart of visitors over 30 days"></div>
        </article>

        <article class="panel categories-panel">
          <div class="panel-heading">
            <div>
              <h2>Category breakdown</h2>
              <p>Largest seeded category includes a seven-digit value</p>
            </div>
          </div>
          <div class="bars" id="categoryBars">
            ${renderBars()}
          </div>
        </article>
      </section>

      <section class="panel table-panel">
        <div class="panel-heading">
          <div>
            <h2>Recent items</h2>
            <p>Latest 20 entries served from PGLite</p>
          </div>
        </div>
        ${renderTable()}
      </section>
    </main>`;

  document.querySelector('#themeToggle')?.addEventListener('click', toggleTheme);
  setupChart();
}

function statCard(label, value, subtext, positive) {
  return `
    <article class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
      <div class="stat-trend ${positive ? 'positive' : 'negative'}">
        <span aria-hidden="true">${positive ? '↗' : '↘'}</span>${escapeHtml(subtext)}
      </div>
    </article>`;
}

function trendText(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

async function toggleTheme() {
  const next = state.settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  const btn = document.querySelector('#themeToggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(next === 'dark'));
    btn.querySelector('.toggle-label').textContent = `${next === 'dark' ? 'Dark' : 'Light'} mode`;
  }
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    console.error(error);
    const rollback = next === 'dark' ? 'light' : 'dark';
    applyTheme(rollback);
  }
}

function renderBars() {
  const max = Math.max(...state.categories.map(c => c.value), 1);
  return state.categories.map(c => {
    const pct = Math.max(8, (c.value / max) * 100);
    return `
      <div class="bar-row">
        <div class="bar-meta">
          <span class="bar-label" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
          <span class="bar-value">${number.format(c.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

function renderTable() {
  const rows = state.recent.map(item => `
    <tr>
      <td data-label="Item"><span class="cell-main">${escapeHtml(item.name)}</span></td>
      <td data-label="Category"><span class="clip" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
      <td data-label="Value" class="numeric">${money.format(item.value)}</td>
      <td data-label="Created">${dateFmt.format(new Date(item.created_at))}</td>
    </tr>`).join('');
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Item</th><th>Category</th><th class="numeric">Value</th><th>Created</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function setupChart() {
  const container = document.querySelector('#visitorChart');
  if (!container) return;
  if (chartResizeObserver) chartResizeObserver.disconnect();
  chartRender = () => drawLineChart(container, state.timeseries);
  chartResizeObserver = new ResizeObserver(chartRender);
  chartResizeObserver.observe(container);
  chartRender();
}

function drawLineChart(container, data) {
  if (!container || !data.length) return;
  const rect = container.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(230, Math.floor(rect.height || 310));
  const narrow = width < 430;
  const margin = narrow ? { top: 18, right: 14, bottom: 48, left: 48 } : { top: 18, right: 20, bottom: 48, left: 58 };
  const innerW = Math.max(10, width - margin.left - margin.right);
  const innerH = Math.max(10, height - margin.top - margin.bottom);
  const values = data.map(d => d.visitors);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  const pad = Math.max(100, (maxRaw - minRaw) * 0.12);
  const min = Math.floor((minRaw - pad) / 100) * 100;
  const max = Math.ceil((maxRaw + pad) / 100) * 100;
  const x = i => margin.left + (i / Math.max(1, data.length - 1)) * innerW;
  const y = v => margin.top + (1 - (v - min) / Math.max(1, max - min)) * innerH;
  const theme = getThemeColors();
  const points = data.map((d, i) => `${x(i).toFixed(2)},${y(d.visitors).toFixed(2)}`).join(' ');
  const ticks = 4;
  const yGrid = Array.from({ length: ticks + 1 }, (_, i) => {
    const value = min + ((max - min) / ticks) * i;
    const yy = y(value);
    return `
      <g>
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${yy}" y2="${yy}" stroke="${theme.grid}" />
        <text x="${margin.left - 8}" y="${yy + 4}" text-anchor="end" class="axis-label">${compact.format(Math.round(value))}</text>
      </g>`;
  }).join('');
  const xIndices = narrow ? [0, 10, 20, 29] : [0, 7, 14, 21, 29];
  const xTicks = xIndices.map(i => `
    <g>
      <line x1="${x(i)}" x2="${x(i)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="${theme.gridSoft}" />
      <text x="${x(i)}" y="${height - 18}" text-anchor="middle" class="axis-label">${dateFmt.format(parseDate(data[i].date))}</text>
    </g>`).join('');
  const area = `${margin.left},${height - margin.bottom} ${points} ${width - margin.right},${height - margin.bottom}`;

  container.innerHTML = `
    <svg role="img" aria-label="Visitors over the last 30 days" viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none">
      <style>
        .axis-label{font:12px system-ui,-apple-system,Segoe UI,sans-serif;fill:${theme.muted}}
      </style>
      <rect width="${width}" height="${height}" fill="transparent" />
      ${yGrid}
      ${xTicks}
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="${theme.axis}" stroke-width="1.25" />
      <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="${theme.axis}" stroke-width="1.25" />
      <polygon points="${area}" fill="${theme.area}" opacity="0.55" />
      <polyline points="${points}" fill="none" stroke="${theme.series}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${data.map((d, i) => (i % (narrow ? 7 : 5) === 0 || i === data.length - 1) ? `<circle cx="${x(i)}" cy="${y(d.visitors)}" r="3.5" fill="${theme.point}" stroke="${theme.card}" stroke-width="2" />` : '').join('')}
    </svg>`;
}

function getThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    muted: styles.getPropertyValue('--muted').trim(),
    grid: styles.getPropertyValue('--chart-grid').trim(),
    gridSoft: styles.getPropertyValue('--chart-grid-soft').trim(),
    axis: styles.getPropertyValue('--chart-axis').trim(),
    series: styles.getPropertyValue('--chart-series').trim(),
    point: styles.getPropertyValue('--chart-point').trim(),
    area: styles.getPropertyValue('--chart-area').trim(),
    card: styles.getPropertyValue('--card').trim()
  };
}

function parseDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

loadDashboard();
