import './styles.css';

const app = document.querySelector('#app');
const numberFmt = new Intl.NumberFormat('en-US');
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

let dashboardData = null;
let lineChart = null;
let resizeObserver = null;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = theme === 'dark' ? 'dark light' : 'light dark';
  if (lineChart) lineChart.draw();
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function statCard(label, value, subtext, trendClass = '') {
  return `
    <article class="card stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-subtext ${trendClass}">${subtext}</div>
    </article>
  `;
}

function renderShell(data) {
  const trendClass = data.summary.sevenDayTrendPct >= 0 ? 'positive' : 'negative';
  const trendPrefix = data.summary.sevenDayTrendPct >= 0 ? '+' : '';

  app.innerHTML = `
    <header class="page-header">
      <div class="header-copy">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
        <p class="lede">Seeded PostgreSQL metrics rendered with responsive, hand-drawn charts.</p>
      </div>
      <button id="themeToggle" class="theme-toggle" type="button" aria-pressed="${data.settings.theme === 'dark'}">
        <span class="toggle-icon" aria-hidden="true">${data.settings.theme === 'dark' ? '☾' : '☼'}</span>
        <span>${data.settings.theme === 'dark' ? 'Dark' : 'Light'} theme</span>
      </button>
    </header>

    <main class="dashboard" aria-live="polite">
      <section class="stats-grid" aria-label="Summary statistics">
        ${statCard('Total visitors', numberFmt.format(data.summary.totalVisitors), '30-day audience')}
        ${statCard('Total revenue', moneyFmt.format(data.summary.totalRevenue), 'Seeded deterministic revenue')}
        ${statCard('Best day', shortDate.format(new Date(`${data.summary.bestDay.date}T00:00:00Z`)), `${numberFmt.format(data.summary.bestDay.visitors)} visitors`)}
        ${statCard('7-day trend', `${trendPrefix}${data.summary.sevenDayTrendPct}%`, 'vs previous 7 days', trendClass)}
      </section>

      <section class="content-grid">
        <article class="card chart-card">
          <div class="card-heading">
            <div>
              <h2>30-day visitors</h2>
              <p>Line chart redraws from SVG coordinates on resize.</p>
            </div>
          </div>
          <div id="lineChart" class="line-chart" role="img" aria-label="30 day visitor time series"></div>
        </article>

        <article class="card breakdown-card">
          <div class="card-heading">
            <div>
              <h2>Category breakdown</h2>
              <p>Labels truncate independently from bars.</p>
            </div>
          </div>
          <div class="bars" aria-label="Category values">
            ${data.categories.map(categoryBar).join('')}
          </div>
        </article>
      </section>

      <section class="card table-card">
        <div class="card-heading">
          <div>
            <h2>Recent items</h2>
            <p>Latest 20 seeded records.</p>
          </div>
        </div>
        ${recentTable(data.recent)}
      </section>
    </main>
  `;

  document.querySelector('#themeToggle').addEventListener('click', toggleTheme);
  const chartEl = document.querySelector('#lineChart');
  lineChart = createLineChart(chartEl, data.timeseries);
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver(() => lineChart.draw());
  resizeObserver.observe(chartEl);
  lineChart.draw();
}

function categoryBar(item) {
  const max = Math.max(...dashboardData.categories.map((c) => c.value));
  const width = Math.max(7, (item.value / max) * 100);
  return `
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
        <span class="bar-value">${numberFmt.format(item.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${width}%"></div></div>
    </div>
  `;
}

function recentTable(items) {
  return `
    <div class="responsive-table" role="table" aria-label="Recent items">
      <div class="table-row table-head" role="row">
        <div role="columnheader">Name</div>
        <div role="columnheader">Category</div>
        <div role="columnheader">Value</div>
        <div role="columnheader">Created</div>
      </div>
      ${items.map((item) => `
        <div class="table-row" role="row">
          <div class="item-name" role="cell" data-label="Name">${escapeHtml(item.name)}</div>
          <div role="cell" data-label="Category"><span class="pill" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></div>
          <div class="numeric" role="cell" data-label="Value">${moneyFmt.format(item.value)}</div>
          <div role="cell" data-label="Created">${shortDate.format(new Date(item.createdAt))}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  const button = document.querySelector('#themeToggle');
  button.disabled = true;
  button.setAttribute('aria-pressed', String(next === 'dark'));
  button.innerHTML = `<span class="toggle-icon" aria-hidden="true">${next === 'dark' ? '☾' : '☼'}</span><span>${next === 'dark' ? 'Dark' : 'Light'} theme</span>`;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    showToast('Theme changed locally, but could not be persisted.');
  } finally {
    button.disabled = false;
  }
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3200);
}

function getCssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function createLineChart(container, rows) {
  return {
    draw() {
      const width = Math.max(280, Math.floor(container.clientWidth));
      const height = Math.max(260, Math.floor(container.clientHeight || 320));
      const isNarrow = width < 430;
      const margin = {
        top: 20,
        right: isNarrow ? 12 : 22,
        bottom: isNarrow ? 48 : 44,
        left: isNarrow ? 44 : 58
      };
      const plotW = Math.max(10, width - margin.left - margin.right);
      const plotH = Math.max(10, height - margin.top - margin.bottom);
      const values = rows.map((d) => d.visitors);
      const min = Math.floor(Math.min(...values) / 100) * 100;
      const max = Math.ceil(Math.max(...values) / 100) * 100;
      const range = max - min || 1;
      const x = (i) => margin.left + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
      const y = (v) => margin.top + plotH - ((v - min) / range) * plotH;
      const path = rows.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ');
      const area = `${path} L ${x(rows.length - 1).toFixed(2)} ${margin.top + plotH} L ${margin.left} ${margin.top + plotH} Z`;
      const tickColor = getCssColor('--muted');
      const gridColor = getCssColor('--grid');
      const axisColor = getCssColor('--axis');
      const seriesColor = getCssColor('--series');
      const fillColor = getCssColor('--series-fill');
      const textSize = isNarrow ? 10 : 11;
      const yTicks = Array.from({ length: 5 }, (_, i) => min + (range * i) / 4);
      const xTickIdx = isNarrow ? [0, 14, 29] : [0, 7, 14, 21, 29];

      container.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
          ${yTicks.map((tick) => `
            <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick)}" y2="${y(tick)}" stroke="${gridColor}" stroke-width="1" />
            <text x="${margin.left - 8}" y="${y(tick) + 4}" text-anchor="end" font-size="${textSize}" fill="${tickColor}">${numberFmt.format(Math.round(tick))}</text>
          `).join('')}
          ${xTickIdx.map((idx) => `
            <line x1="${x(idx)}" x2="${x(idx)}" y1="${margin.top}" y2="${margin.top + plotH}" stroke="${gridColor}" stroke-width="1" />
            <text x="${x(idx)}" y="${height - 16}" text-anchor="middle" font-size="${textSize}" fill="${tickColor}">${shortDate.format(new Date(`${rows[idx].date}T00:00:00Z`))}</text>
          `).join('')}
          <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1.25" />
          <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotH}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1.25" />
          <path d="${area}" fill="${fillColor}" />
          <path d="${path}" fill="none" stroke="${seriesColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          ${rows.map((d, i) => i % (isNarrow ? 5 : 3) === 0 || i === rows.length - 1 ? `<circle cx="${x(i)}" cy="${y(d.visitors)}" r="3" fill="${seriesColor}" stroke="${getCssColor('--card')}" stroke-width="1.5" />` : '').join('')}
        </svg>
      `;
    }
  };
}

function renderError(error) {
  app.innerHTML = `
    <main class="error-state">
      <section class="card error-card">
        <p class="eyebrow">Dashboard unavailable</p>
        <h1>Could not load API data</h1>
        <p>The dashboard intentionally renders only from live API responses. Start the backend server and reload this page.</p>
        <pre>${escapeHtml(error.message)}</pre>
        <button type="button" onclick="location.reload()">Retry</button>
      </section>
    </main>
  `;
}

async function boot() {
  try {
    const settings = await api('/api/settings');
    setTheme(settings.theme);
    document.documentElement.classList.remove('theme-pending');
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent')
    ]);
    dashboardData = { settings, summary, timeseries, categories, recent };
    renderShell(dashboardData);
  } catch (error) {
    document.documentElement.classList.remove('theme-pending');
    renderError(error);
  }
}

boot();
