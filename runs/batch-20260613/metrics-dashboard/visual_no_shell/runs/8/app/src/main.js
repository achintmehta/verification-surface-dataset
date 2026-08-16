import './styles.css';

const app = document.querySelector('#app');

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  chartObserver: null
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
    toggle.querySelector('.toggle-text').textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  }
  drawLineChart();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function loadTheme() {
  try {
    const settings = await fetchJson('/api/settings');
    setTheme(settings.theme);
  } catch {
    setTheme('light');
  }
}

function shell() {
  app.innerHTML = `
    <header class="topbar">
      <div class="brand-block">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
      </div>
      <button id="themeToggle" class="theme-toggle" type="button" aria-pressed="false">
        <span class="toggle-icon" aria-hidden="true"></span>
        <span class="toggle-text">Light</span>
      </button>
    </header>
    <main>
      <section id="status" class="status-card" aria-live="polite">Loading dashboard data…</section>
      <section id="dashboard" class="dashboard hidden" aria-label="Metrics dashboard">
        <div id="stats" class="stats-grid"></div>
        <section class="panel chart-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">30 day performance</p>
              <h2>Visitors trend</h2>
            </div>
            <span class="subtle">Daily visitors</span>
          </div>
          <div id="chartWrap" class="chart-wrap" role="img" aria-label="Line chart of daily visitors for thirty days"></div>
        </section>
        <section class="panel categories-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Breakdown</p>
              <h2>Category value</h2>
            </div>
          </div>
          <div id="categories" class="category-list"></div>
        </section>
        <section class="panel table-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Latest activity</p>
              <h2>Recent items</h2>
            </div>
          </div>
          <div id="recent" class="table-shell"></div>
        </section>
      </section>
    </main>
  `;
  document.querySelector('#themeToggle').addEventListener('click', toggleTheme);
}

async function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  try {
    await fetchJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  } catch (error) {
    showToast('Theme could not be saved on the server.');
  }
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

function renderStats() {
  const best = state.summary.bestDay;
  const trend = state.summary.sevenDayTrendPercent;
  const cards = [
    { label: 'Total visitors', value: number.format(state.summary.totalVisitors), meta: `${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}% last 7 days`, trend },
    { label: 'Total revenue', value: money.format(state.summary.totalRevenue), meta: 'Seeded 30-day total', wide: true },
    { label: 'Best day', value: best ? dateFmt.format(new Date(`${best.day}T00:00:00Z`)) : '—', meta: best ? `${money.format(best.revenue)} revenue` : 'No data' },
    { label: 'Avg daily visitors', value: number.format(Math.round(state.summary.totalVisitors / Math.max(1, state.timeseries.length))), meta: `${state.timeseries.length} deterministic days` }
  ];
  document.querySelector('#stats').innerHTML = cards.map((card) => `
    <article class="stat-card">
      <div class="stat-label">${escapeHtml(card.label)}</div>
      <div class="stat-value ${card.wide ? 'allow-tight' : ''}">${escapeHtml(card.value)}</div>
      <div class="stat-meta ${card.trend !== undefined ? (card.trend >= 0 ? 'positive' : 'negative') : ''}">${escapeHtml(card.meta)}</div>
    </article>
  `).join('');
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawLineChart() {
  const wrap = document.querySelector('#chartWrap');
  if (!wrap || !state.timeseries.length) return;
  const rect = wrap.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height || 320));
  const left = width < 420 ? 48 : 62;
  const right = width < 420 ? 14 : 24;
  const top = 20;
  const bottom = width < 420 ? 54 : 46;
  const innerW = Math.max(10, width - left - right);
  const innerH = Math.max(10, height - top - bottom);
  const values = state.timeseries.map((d) => Number(d.visitors));
  const min = Math.floor(Math.min(...values) / 100) * 100;
  const max = Math.ceil(Math.max(...values) / 100) * 100;
  const range = Math.max(1, max - min);
  const x = (i) => left + (i / (values.length - 1)) * innerW;
  const y = (v) => top + innerH - ((v - min) / range) * innerH;
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const grid = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = min + (range * i) / 4;
    const yy = y(value);
    grid.push(`<line class="gridline" x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" />`);
    grid.push(`<text class="axis-label y-label" x="${left - 8}" y="${yy + 4}" text-anchor="end">${compact.format(value)}</text>`);
  }
  const tickIndexes = width < 420 ? [0, 14, 29] : width < 700 ? [0, 7, 14, 21, 29] : [0, 5, 10, 15, 20, 25, 29];
  const ticks = tickIndexes.map((idx) => {
    const xx = x(idx);
    const label = dateFmt.format(new Date(`${state.timeseries[idx].date}T00:00:00Z`));
    return `<g><line class="tick" x1="${xx}" x2="${xx}" y1="${height - bottom}" y2="${height - bottom + 5}"/><text class="axis-label x-label" x="${xx}" y="${height - bottom + 22}" text-anchor="middle">${label}</text></g>`;
  }).join('');
  wrap.innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" aria-hidden="true">
      <rect class="plot-bg" x="${left}" y="${top}" width="${innerW}" height="${innerH}" rx="10" />
      ${grid.join('')}
      <line class="axis" x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}" />
      <line class="axis" x1="${left}" x2="${left}" y1="${top}" y2="${height - bottom}" />
      ${ticks}
      <polyline class="series-shadow" points="${points}" />
      <polyline class="series" points="${points}" />
      ${values.map((v, i) => i % 5 === 0 || i === values.length - 1 ? `<circle class="point" cx="${x(i)}" cy="${y(v)}" r="3.2" />` : '').join('')}
    </svg>
  `;
}

function renderCategories() {
  const max = Math.max(...state.categories.map((c) => Number(c.value)), 1);
  document.querySelector('#categories').innerHTML = state.categories.map((cat) => {
    const pct = Math.max(5, Math.round((Number(cat.value) / max) * 100));
    return `
      <div class="category-row">
        <div class="category-top">
          <span class="category-name" title="${escapeHtml(cat.label)}">${escapeHtml(cat.label)}</span>
          <span class="category-value">${number.format(cat.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('');
}

function renderRecent() {
  document.querySelector('#recent').innerHTML = `
    <table>
      <thead>
        <tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr>
      </thead>
      <tbody>
        ${state.recent.map((item) => `
          <tr>
            <td data-label="Name"><span class="cell-main">${escapeHtml(item.name)}</span></td>
            <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
            <td data-label="Value">${number.format(item.value)}</td>
            <td data-label="Date">${dateFmt.format(new Date(item.created_at))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function setupResize() {
  if (state.chartObserver) state.chartObserver.disconnect();
  const wrap = document.querySelector('#chartWrap');
  if (!wrap) return;
  state.chartObserver = new ResizeObserver(() => drawLineChart());
  state.chartObserver.observe(wrap);
  window.addEventListener('resize', drawLineChart, { passive: true });
}

async function loadData() {
  const status = document.querySelector('#status');
  const dashboard = document.querySelector('#dashboard');
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/api/summary'), fetchJson('/api/timeseries'), fetchJson('/api/categories'), fetchJson('/api/recent')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    renderStats();
    renderCategories();
    renderRecent();
    status.classList.add('hidden');
    dashboard.classList.remove('hidden');
    setupResize();
    drawLineChart();
  } catch (error) {
    dashboard.classList.add('hidden');
    status.className = 'status-card error-state';
    status.innerHTML = `<strong>Dashboard data unavailable.</strong><span>The API could not be reached, so no hardcoded or stale metrics are shown. Start the backend and reload.</span>`;
  }
}

shell();
await loadTheme();
loadData();
