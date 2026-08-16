import './styles.css';

const app = document.querySelector('#app');
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const df = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

let dashboardData = null;
let chartObserver = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function getJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function parseMetricDate(value) {
  const text = String(value);
  return new Date(text.includes('T') ? text : `${text}T00:00:00`);
}

function renderShell() {
  app.innerHTML = `
    <main class="dashboard-shell">
      <header class="topbar">
        <div class="title-wrap">
          <p class="eyebrow">Seeded PGLite analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle dark theme">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span id="themeText">${currentTheme() === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
      </header>
      <section id="message" class="message" hidden></section>
      <section class="stats-grid" id="statsGrid" aria-label="Summary metrics"></section>
      <section class="body-grid">
        <article class="panel chart-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Last 30 days</p>
              <h2>Visitors trend</h2>
            </div>
            <span class="metric-chip">Daily visitors</span>
          </div>
          <div id="chart" class="chart-box" aria-label="30 day visitors line chart"></div>
        </article>
        <article class="panel breakdown-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Portfolio</p>
              <h2>Category breakdown</h2>
            </div>
          </div>
          <div id="categories" class="category-list"></div>
        </article>
      </section>
      <section class="panel table-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Latest records</p>
            <h2>Recent items</h2>
          </div>
        </div>
        <div id="recent"></div>
      </section>
    </main>
  `;

  document.querySelector('#themeToggle').addEventListener('click', toggleTheme);
}

function showMessage(text, type = 'error') {
  const el = document.querySelector('#message');
  if (!el) return;
  el.hidden = false;
  el.className = `message ${type}`;
  el.textContent = text;
}

function statCard(label, value, note, trendClass = '') {
  return `
    <article class="stat-card">
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <span class="stat-note ${trendClass}">${escapeHtml(note)}</span>
    </article>
  `;
}

function renderStats(summary) {
  const trend = summary.sevenDayTrendPct;
  const bestDate = parseMetricDate(summary.bestDay.date);
  document.querySelector('#statsGrid').innerHTML = [
    statCard('Total visitors', nf.format(summary.totalVisitors), '30 day total'),
    statCard('Total revenue', cf.format(summary.totalRevenue), 'Seeded revenue'),
    statCard('Best day', df.format(bestDate), `${cf.format(summary.bestDay.revenue)} revenue`),
    statCard('7-day trend', `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`, 'vs previous 7 days', trend >= 0 ? 'positive' : 'negative')
  ].join('');
}

function niceTicks(min, max, count) {
  if (max === min) return [min];
  const span = max - min;
  const step = Math.ceil(span / count / 100) * 100;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step; v += step) ticks.push(v);
  return ticks.slice(-6);
}

function renderChart(data) {
  const container = document.querySelector('#chart');
  if (!container || !data?.length) return;
  const width = Math.max(300, Math.floor(container.clientWidth));
  const height = width < 430 ? 260 : 320;
  const margin = width < 430 ? { top: 22, right: 16, bottom: 56, left: 48 } : { top: 26, right: 24, bottom: 58, left: 62 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const values = data.map((d) => d.visitors);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const yMin = Math.max(0, Math.floor((min - 250) / 100) * 100);
  const yMax = Math.ceil((max + 250) / 100) * 100;
  const ticks = niceTicks(yMin, yMax, 5);
  const x = (i) => margin.left + (plotW * i) / (data.length - 1);
  const y = (v) => margin.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ');
  const theme = currentTheme();
  const colors = theme === 'dark'
    ? { grid: '#334155', axis: '#94a3b8', text: '#cbd5e1', line: '#38bdf8', fill: 'rgba(56,189,248,.16)', dot: '#e0f2fe' }
    : { grid: '#dbe3ef', axis: '#64748b', text: '#334155', line: '#2563eb', fill: 'rgba(37,99,235,.12)', dot: '#1d4ed8' };
  const area = `${path} L ${x(data.length - 1).toFixed(2)} ${margin.top + plotH} L ${margin.left} ${margin.top + plotH} Z`;
  const labelEvery = width < 430 ? 7 : 5;

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chartTitle" preserveAspectRatio="none">
      <title id="chartTitle">30 day visitor trend</title>
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      ${ticks.map((t) => `
        <g>
          <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(t).toFixed(2)}" y2="${y(t).toFixed(2)}" stroke="${colors.grid}" stroke-width="1" />
          <text x="${margin.left - 10}" y="${(y(t) + 4).toFixed(2)}" text-anchor="end" fill="${colors.text}" font-size="12">${nf.format(t)}</text>
        </g>
      `).join('')}
      <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="${colors.axis}" />
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="${colors.axis}" />
      <path d="${area}" fill="${colors.fill}" />
      <path d="${path}" fill="none" stroke="${colors.line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${data.map((d, i) => i % labelEvery === 0 || i === data.length - 1 ? `
        <g>
          <line x1="${x(i).toFixed(2)}" x2="${x(i).toFixed(2)}" y1="${height - margin.bottom}" y2="${height - margin.bottom + 5}" stroke="${colors.axis}" />
          <text x="${x(i).toFixed(2)}" y="${height - margin.bottom + 22}" fill="${colors.text}" font-size="12" text-anchor="${i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}">${df.format(parseMetricDate(d.date))}</text>
        </g>
      ` : '').join('')}
      ${data.map((d, i) => i % 3 === 0 || i === data.length - 1 ? `<circle cx="${x(i).toFixed(2)}" cy="${y(d.visitors).toFixed(2)}" r="3" fill="${colors.dot}" stroke="${colors.line}" stroke-width="1.5" />` : '').join('')}
    </svg>
  `;
}

function renderCategories(categories) {
  const max = Math.max(...categories.map((c) => c.value));
  document.querySelector('#categories').innerHTML = categories.map((cat) => {
    const pct = Math.max(6, (cat.value / max) * 100);
    return `
      <div class="category-row">
        <div class="category-topline">
          <span class="category-label" title="${escapeHtml(cat.label)}">${escapeHtml(cat.label)}</span>
          <strong class="category-value">${nf.format(cat.value)}</strong>
        </div>
        <div class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${pct}%"></span></div>
      </div>
    `;
  }).join('');
}

function renderRecent(items) {
  document.querySelector('#recent').innerHTML = `
    <table class="recent-table">
      <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
      <tbody>
        ${items.map((item) => `
          <tr>
            <td data-label="Name"><span class="cell-strong">${escapeHtml(item.name)}</span></td>
            <td data-label="Category"><span>${escapeHtml(item.category)}</span></td>
            <td data-label="Value"><span>${cf.format(item.value)}</span></td>
            <td data-label="Created"><span>${df.format(new Date(item.created_at))}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function installChartResize() {
  if (chartObserver) chartObserver.disconnect();
  const chart = document.querySelector('#chart');
  if (!chart) return;
  chartObserver = new ResizeObserver(() => {
    if (dashboardData?.timeseries) renderChart(dashboardData.timeseries);
  });
  chartObserver.observe(chart);
}

async function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const previous = currentTheme();
  document.documentElement.dataset.theme = next;
  document.querySelector('#themeText').textContent = next === 'dark' ? 'Dark' : 'Light';
  if (dashboardData?.timeseries) renderChart(dashboardData.timeseries);
  try {
    await getJson('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    document.documentElement.dataset.theme = previous;
    document.querySelector('#themeText').textContent = previous === 'dark' ? 'Dark' : 'Light';
    if (dashboardData?.timeseries) renderChart(dashboardData.timeseries);
    showMessage('Theme could not be saved because the API is unavailable.', 'error');
  }
}

async function loadDashboard() {
  renderShell();
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      getJson('/api/settings'),
      getJson('/api/summary'),
      getJson('/api/timeseries'),
      getJson('/api/categories'),
      getJson('/api/recent')
    ]);
    document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
    document.querySelector('#themeText').textContent = currentTheme() === 'dark' ? 'Dark' : 'Light';
    dashboardData = { summary, timeseries, categories, recent };
    renderStats(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderRecent(recent);
    installChartResize();
  } catch (error) {
    console.error(error);
    dashboardData = null;
    showMessage('Unable to load dashboard data. Start the backend API and reload the page.', 'error');
    document.querySelector('#statsGrid').innerHTML = '';
    document.querySelector('#chart').innerHTML = '<div class="empty-state">No chart data available.</div>';
    document.querySelector('#categories').innerHTML = '<div class="empty-state">No category data available.</div>';
    document.querySelector('#recent').innerHTML = '<div class="empty-state">No recent items available.</div>';
  }
}

loadDashboard();
