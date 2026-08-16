const app = document.querySelector('#app');
const nf = new Intl.NumberFormat('en-US');
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const shortCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const shortNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

let state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  error: null,
};
let resizeObserver;
let drawQueued = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function svgText(value) {
  return escapeHtml(value);
}

function parseLocalDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date(`${value}T00:00:00`) : d;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function loadDashboard() {
  app.innerHTML = '<main class="boot-shell" aria-live="polite">Loading dashboard…</main>';
  try {
    const settingsPromise = window.__themeReady || getJson('/api/settings');
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      settingsPromise,
      getJson('/api/summary'),
      getJson('/api/timeseries'),
      getJson('/api/categories'),
      getJson('/api/recent'),
    ]);
    state = {
      theme: settings.theme === 'dark' ? 'dark' : 'light',
      summary,
      timeseries,
      categories,
      recent,
      error: null,
    };
    document.documentElement.dataset.theme = state.theme;
    render();
  } catch (err) {
    state.error = err;
    renderError(err);
  }
}

function renderError(err) {
  app.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Metrics Dashboard</p>
          <h1>Unable to load dashboard data</h1>
        </div>
      </header>
      <section class="error-card" role="alert">
        <h2>Backend connection required</h2>
        <p>The dashboard renders entirely from API data. Start the Node/PGLite server and refresh this page.</p>
        <code>${escapeHtml(err.message || err)}</code>
        <button class="primary-button" id="retryBtn">Retry</button>
      </section>
    </main>`;
  document.querySelector('#retryBtn')?.addEventListener('click', loadDashboard);
}

function render() {
  app.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div class="title-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
          <p class="subtle">30-day performance, category mix, and recent high-value activity.</p>
        </div>
        <button class="theme-toggle" id="themeToggle" type="button" aria-pressed="${state.theme === 'dark'}">
          <span class="toggle-knob" aria-hidden="true"></span>
          <span id="themeText">${state.theme === 'dark' ? 'Dark' : 'Light'} mode</span>
        </button>
      </header>

      <section class="stats-grid" aria-label="Summary metrics">
        ${statCard('Total Visitors', nf.format(state.summary.totalVisitors), 'Across the seeded 30-day window', 'visitors', 'neutral')}
        ${statCard('Total Revenue', currency.format(state.summary.totalRevenue), 'Recognized revenue for the period', 'revenue', 'neutral strong-value')}
        ${statCard('Best Day', dateFmt.format(parseLocalDate(state.summary.bestDay.date)), `${nf.format(state.summary.bestDay.visitors)} visitors`, 'calendar', 'neutral')}
        ${statCard('7-Day Trend', `${state.summary.sevenDayTrendPct >= 0 ? '+' : ''}${state.summary.sevenDayTrendPct}%`, 'vs. previous 7 days', 'trend', state.summary.sevenDayTrendPct >= 0 ? 'positive' : 'negative')}
      </section>

      <section class="dashboard-grid">
        <article class="card chart-card">
          <div class="card-header">
            <div>
              <h2>30-Day Visitors</h2>
              <p>Hand-drawn SVG line chart, resized to the card.</p>
            </div>
            <span class="pill">Daily</span>
          </div>
          <div id="lineChart" class="chart-box" role="img" aria-label="30-day visitors time-series chart"></div>
        </article>

        <article class="card categories-card">
          <div class="card-header">
            <div>
              <h2>Category Breakdown</h2>
              <p>Revenue contribution by operating category.</p>
            </div>
          </div>
          <div class="bars" id="categoryBars">
            ${categoryBars(state.categories)}
          </div>
        </article>
      </section>

      <section class="card table-card">
        <div class="card-header">
          <div>
            <h2>Recent Items</h2>
            <p>Latest seeded dashboard records.</p>
          </div>
        </div>
        ${recentTable(state.recent)}
      </section>
    </main>`;

  document.querySelector('#themeToggle')?.addEventListener('click', toggleTheme);
  setupChartResize();
  scheduleDraw();
}

function statCard(label, value, detail, icon, tone) {
  const iconMap = { visitors: '👥', revenue: '💵', calendar: '📅', trend: '↗' };
  return `
    <article class="stat-card ${tone}">
      <div class="stat-top">
        <span class="stat-label">${escapeHtml(label)}</span>
        <span class="stat-icon" aria-hidden="true">${iconMap[icon] || '•'}</span>
      </div>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <span class="stat-detail">${escapeHtml(detail)}</span>
    </article>`;
}

function categoryBars(categories) {
  const max = Math.max(...categories.map((c) => c.value), 1);
  return categories.map((c) => {
    const pct = Math.max(8, Math.round((c.value / max) * 100));
    return `
      <div class="bar-row">
        <div class="bar-meta">
          <span class="bar-label" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
          <span class="bar-value">${currency.format(c.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${pct}%"></span></div>
      </div>`;
  }).join('');
}

function recentTable(items) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr></thead>
        <tbody>
          ${items.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-strong">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${currency.format(item.value)}</td>
              <td data-label="Date">${dateFmt.format(parseLocalDate(item.createdAt))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    const saved = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
    if (!saved.ok) throw new Error('Theme save failed');
    const body = await saved.json();
    state.theme = body.theme;
    applyTheme(body.theme);
  } catch (err) {
    console.error(err);
    const note = document.createElement('div');
    note.className = 'toast';
    note.textContent = 'Could not persist theme preference.';
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 2800);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  const btn = document.querySelector('#themeToggle');
  const text = document.querySelector('#themeText');
  if (btn) btn.setAttribute('aria-pressed', String(theme === 'dark'));
  if (text) text.textContent = `${theme === 'dark' ? 'Dark' : 'Light'} mode`;
  scheduleDraw();
}

function setupChartResize() {
  if (resizeObserver) resizeObserver.disconnect();
  const box = document.querySelector('#lineChart');
  if (!box) return;
  resizeObserver = new ResizeObserver(scheduleDraw);
  resizeObserver.observe(box);
  window.addEventListener('orientationchange', scheduleDraw, { passive: true });
}

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    drawLineChart();
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceTicks(min, max, count) {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = niceNorm * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

function drawLineChart() {
  const box = document.querySelector('#lineChart');
  if (!box || !state.timeseries.length) return;
  const rect = box.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height || 320));
  const m = width < 420 ? { top: 18, right: 14, bottom: 46, left: 50 } : { top: 22, right: 24, bottom: 52, left: 64 };
  const plotW = Math.max(1, width - m.left - m.right);
  const plotH = Math.max(1, height - m.top - m.bottom);

  const values = state.timeseries.map((d) => d.visitors);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1000, (max - min) * 0.08);
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const denom = Math.max(1, yMax - yMin);
  const x = (i) => m.left + (i / Math.max(1, state.timeseries.length - 1)) * plotW;
  const y = (v) => m.top + (1 - (v - yMin) / denom) * plotH;
  const path = state.timeseries.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ');
  const ticks = niceTicks(yMin, yMax, width < 420 ? 4 : 5).slice(0, 6);
  const xTickIdx = width < 420 ? [0, 14, 29] : [0, 7, 14, 21, 29];

  const grid = ticks.map((t) => {
    const yy = y(t);
    return `<line x1="${m.left}" x2="${width - m.right}" y1="${yy}" y2="${yy}" class="grid" />
      <text x="${m.left - 9}" y="${yy + 4}" text-anchor="end" class="axis-label">${svgText(shortNumber.format(t))}</text>`;
  }).join('');

  const xLabels = xTickIdx.map((idx) => {
    const xx = x(idx);
    const label = dateFmt.format(parseLocalDate(state.timeseries[idx].date));
    return `<line x1="${xx}" x2="${xx}" y1="${m.top + plotH}" y2="${m.top + plotH + 5}" class="tick" />
      <text x="${xx}" y="${height - 18}" text-anchor="middle" class="axis-label">${svgText(label)}</text>`;
  }).join('');

  box.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
      ${grid}
      <line x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${m.top + plotH}" class="axis" />
      <line x1="${m.left}" x2="${width - m.right}" y1="${m.top + plotH}" y2="${m.top + plotH}" class="axis" />
      ${xLabels}
      <path d="${path}" class="series-shadow" />
      <path d="${path}" class="series" />
      ${state.timeseries.map((d, i) => i % (width < 420 ? 6 : 4) === 0 || i === state.timeseries.length - 1 ? `<circle cx="${x(i)}" cy="${y(d.visitors)}" r="3.2" class="point"><title>${svgText(dateFmt.format(parseLocalDate(d.date)))}: ${svgText(nf.format(d.visitors))} visitors</title></circle>` : '').join('')}
    </svg>`;
}

loadDashboard();
