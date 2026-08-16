import './styles.css';

const API = '';
const app = document.getElementById('app');

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  resizeObserver: null
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

async function api(path, options) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function setTheme(theme, remember = true) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', state.theme);
  if (remember) {
    try { localStorage.setItem('preferred-theme', state.theme); } catch (e) {}
  }
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.checked = state.theme === 'dark';
    toggle.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
  }
  drawChart();
}

function renderShell() {
  app.innerHTML = `
    <div class="page-shell">
      <header class="topbar">
        <div class="title-wrap">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Seeded PGLite data rendered through a responsive vanilla UI.</p>
        </div>
        <label class="theme-switch">
          <span class="switch-label">Theme</span>
          <input id="themeToggle" type="checkbox" ${state.theme === 'dark' ? 'checked' : ''} />
          <span class="slider" aria-hidden="true"></span>
        </label>
      </header>
      <main>
        <section class="stats-grid" id="statsGrid"></section>
        <section class="body-grid">
          <article class="panel chart-panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">30 day series</p>
                <h2>Visitors trend</h2>
              </div>
              <span class="panel-note">SVG redraws on resize</span>
            </div>
            <div class="chart-wrap" id="chartWrap" aria-label="30 day visitors line chart"></div>
          </article>
          <article class="panel category-panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">Breakdown</p>
                <h2>Revenue by category</h2>
              </div>
            </div>
            <div class="bars" id="categoryBars"></div>
          </article>
        </section>
        <section class="panel table-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Latest activity</p>
              <h2>Recent items</h2>
            </div>
          </div>
          <div id="recentTable"></div>
        </section>
      </main>
    </div>`;

  document.querySelector('#themeToggle').addEventListener('change', async (event) => {
    const next = event.target.checked ? 'dark' : 'light';
    setTheme(next);
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
    } catch (err) {
      showToast('Theme changed locally, but could not be saved to the server.');
    }
  });
}

function renderStats() {
  const s = state.summary;
  const bestDate = s.bestDay ? dateFmt.format(new Date(`${s.bestDay.date}T00:00:00Z`)) : '—';
  const trendUp = s.sevenDayTrendPct >= 0;
  const cards = [
    { label: 'Total visitors', value: number.format(s.totalVisitors), detail: '30 seeded days', trend: 'traffic' },
    { label: 'Total revenue', value: money.format(s.totalRevenue), detail: 'Large value wraps safely', trend: 'revenue' },
    { label: 'Best day', value: bestDate, detail: s.bestDay ? `${money.format(s.bestDay.revenue)} revenue` : 'No data', trend: 'peak' },
    { label: '7-day trend', value: `${trendUp ? '+' : ''}${s.sevenDayTrendPct.toFixed(1)}%`, detail: 'vs previous 7-day avg', trend: trendUp ? 'up' : 'down' }
  ];
  document.querySelector('#statsGrid').innerHTML = cards.map(card => `
    <article class="stat-card">
      <div class="stat-topline">
        <span>${escapeHtml(card.label)}</span>
        <span class="trend ${card.trend === 'down' ? 'negative' : 'positive'}">${card.trend === 'down' ? '↓' : '↑'}</span>
      </div>
      <strong class="stat-value" title="${escapeHtml(card.value)}">${escapeHtml(card.value)}</strong>
      <p>${escapeHtml(card.detail)}</p>
    </article>
  `).join('');
}

function renderCategories() {
  const max = Math.max(...state.categories.map(c => c.value), 1);
  document.querySelector('#categoryBars').innerHTML = state.categories.map(c => {
    const pct = Math.max(4, (c.value / max) * 100);
    return `
      <div class="bar-row">
        <div class="bar-meta">
          <span class="bar-label" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
          <span class="bar-value">${money.format(c.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${pct}%"></span></div>
      </div>`;
  }).join('');
}

function renderRecent() {
  document.querySelector('#recentTable').innerHTML = `
    <table class="recent-table">
      <thead><tr><th>Item</th><th>Category</th><th>Value</th><th>Date</th></tr></thead>
      <tbody>
        ${state.recent.map(item => `
          <tr>
            <td data-label="Item"><span class="cell-main" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></td>
            <td data-label="Category"><span class="pill" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
            <td data-label="Value" class="numeric">${money.format(item.value)}</td>
            <td data-label="Date">${escapeHtml(dateFmt.format(new Date(item.createdAt)))}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceTicks(min, max, count = 4) {
  const span = Math.max(1, max - min);
  const raw = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.ceil(raw / pow) * pow;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step; v += step) ticks.push(v);
  return ticks.slice(-7);
}

function drawChart() {
  const wrap = document.querySelector('#chartWrap');
  if (!wrap || !state.timeseries.length) return;
  const width = Math.max(280, Math.floor(wrap.clientWidth));
  const height = width < 420 ? 250 : 310;
  const margin = width < 420 ? { top: 22, right: 18, bottom: 42, left: 48 } : { top: 24, right: 24, bottom: 46, left: 58 };
  const innerW = Math.max(10, width - margin.left - margin.right);
  const innerH = Math.max(10, height - margin.top - margin.bottom);
  const values = state.timeseries.map(d => d.visitors);
  const min = Math.floor(Math.min(...values) * 0.94);
  const max = Math.ceil(Math.max(...values) * 1.04);
  const x = i => margin.left + (state.timeseries.length === 1 ? 0 : (i / (state.timeseries.length - 1)) * innerW);
  const y = v => margin.top + innerH - ((v - min) / (max - min || 1)) * innerH;
  const line = state.timeseries.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ');
  const area = `${line} L ${x(state.timeseries.length - 1).toFixed(2)} ${margin.top + innerH} L ${margin.left} ${margin.top + innerH} Z`;
  const yTicks = niceTicks(min, max, 4).filter(t => t >= min && t <= max);
  const xTickIndexes = width < 420 ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const grid = cssVar('--grid');
  const axis = cssVar('--axis');
  const text = cssVar('--muted');
  const series = cssVar('--series');
  const fill = cssVar('--series-fill');
  wrap.innerHTML = `
    <svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chartTitle chartDesc">
      <title id="chartTitle">30 day visitors</title>
      <desc id="chartDesc">Line chart showing visitors for each of the thirty seeded days.</desc>
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      ${yTicks.map(t => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(t)}" y2="${y(t)}" stroke="${grid}" stroke-width="1"/>`).join('')}
      <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + innerH}" stroke="${axis}" stroke-width="1.2"/>
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + innerH}" y2="${margin.top + innerH}" stroke="${axis}" stroke-width="1.2"/>
      ${yTicks.map(t => `<text x="${margin.left - 8}" y="${y(t) + 4}" text-anchor="end" fill="${text}" font-size="11">${compact.format(t)}</text>`).join('')}
      ${xTickIndexes.map(i => {
        const d = state.timeseries[Math.min(i, state.timeseries.length - 1)];
        return `<g><line x1="${x(i)}" x2="${x(i)}" y1="${margin.top + innerH}" y2="${margin.top + innerH + 5}" stroke="${axis}"/><text x="${x(i)}" y="${height - 16}" text-anchor="middle" fill="${text}" font-size="11">${dateFmt.format(new Date(d.date + 'T00:00:00Z'))}</text></g>`;
      }).join('')}
      <path d="${area}" fill="${fill}"></path>
      <path d="${line}" fill="none" stroke="${series}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      ${state.timeseries.map((d, i) => (i % 5 === 0 || i === state.timeseries.length - 1) ? `<circle cx="${x(i)}" cy="${y(d.visitors)}" r="3.2" fill="${series}" stroke="${cssVar('--card')}" stroke-width="2"></circle>` : '').join('')}
    </svg>`;
}

function installResizeObserver() {
  if (state.resizeObserver) state.resizeObserver.disconnect();
  const wrap = document.querySelector('#chartWrap');
  if (!wrap) return;
  if ('ResizeObserver' in window) {
    state.resizeObserver = new ResizeObserver(() => requestAnimationFrame(drawChart));
    state.resizeObserver.observe(wrap);
  } else {
    window.addEventListener('resize', drawChart);
  }
}

function showToast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3500);
}

function renderError(err) {
  console.error(err);
  app.innerHTML = `
    <div class="page-shell error-shell">
      <header class="topbar"><div><p class="eyebrow">Metrics Dashboard</p><h1>Unable to load dashboard data</h1></div></header>
      <main class="error-card">
        <h2>No API data available</h2>
        <p>The dashboard is rendered only from the JSON API. Start the backend server and reload this page.</p>
        <code>${escapeHtml(err.message || err)}</code>
        <button type="button" onclick="location.reload()">Retry</button>
      </main>
    </div>`;
}

async function boot() {
  try {
    const settings = await api('/api/settings');
    setTheme(settings.theme, true);
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'), api('/api/timeseries'), api('/api/categories'), api('/api/recent')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    renderShell();
    renderStats();
    renderCategories();
    renderRecent();
    setTheme(state.theme, false);
    installResizeObserver();
    drawChart();
  } catch (err) {
    renderError(err);
  }
}

boot();
