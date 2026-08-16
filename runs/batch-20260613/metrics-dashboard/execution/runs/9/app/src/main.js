import './styles.css';

const app = document.querySelector('#app');
const numberFmt = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

const state = {
  summary: null,
  series: [],
  categories: [],
  recent: [],
  theme: 'light',
  chartObserver: null
};

function api(path, options) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  });
}

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const button = document.querySelector('#themeToggle');
  if (button) {
    button.setAttribute('aria-pressed', String(state.theme === 'dark'));
    button.querySelector('.toggle-text').textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  }
  drawChart();
}

async function loadSettingsBeforeRender() {
  try {
    const settings = await api('/api/settings');
    setTheme(settings.theme);
  } catch {
    setTheme('light');
  } finally {
    document.documentElement.classList.remove('booting');
  }
}

function statCards(summary) {
  const trendUp = summary.trendPct >= 0;
  return [
    { label: 'Total visitors', value: numberFmt.format(summary.totalVisitors), sub: 'Last 30 days', tone: 'blue' },
    { label: 'Total revenue', value: currencyFmt.format(summary.totalRevenue), sub: 'Deterministic seed', tone: 'green' },
    { label: 'Best day', value: numberFmt.format(summary.bestDay.visitors), sub: dateFmt.format(new Date(`${summary.bestDay.date}T00:00:00Z`)), tone: 'purple' },
    { label: '7-day trend', value: `${trendUp ? '+' : ''}${summary.trendPct.toFixed(1)}%`, sub: 'vs previous 7 days', tone: trendUp ? 'green' : 'red', trend: trendUp ? '↗' : '↘' }
  ].map((card) => `
    <article class="stat-card ${card.tone}">
      <div class="stat-top">
        <span>${card.label}</span>
        ${card.trend ? `<strong class="trend-icon">${card.trend}</strong>` : ''}
      </div>
      <strong class="stat-value" title="${card.value}">${card.value}</strong>
      <span class="stat-sub">${card.sub}</span>
    </article>
  `).join('');
}

function shell({ error = '' } = {}) {
  app.innerHTML = `
    <div class="dashboard-shell">
      <header class="topbar">
        <div class="brand-block">
          <p class="eyebrow">PGLite analytics</p>
          <h1>Metrics Dashboard</h1>
          <p class="lede">Seeded operational metrics rendered by a dependency-light responsive UI.</p>
        </div>
        <button id="themeToggle" class="theme-toggle" type="button" aria-pressed="${state.theme === 'dark'}">
          <span class="sun" aria-hidden="true">☀</span>
          <span class="toggle-text">${state.theme === 'dark' ? 'Dark' : 'Light'}</span>
          <span class="moon" aria-hidden="true">☾</span>
        </button>
      </header>
      ${error ? `<section class="error-state"><h2>Dashboard data unavailable</h2><p>${error}</p><button id="retryLoad">Retry</button></section>` : `
        <main>
          <section class="stats-grid" aria-label="Summary statistics">${statCards(state.summary)}</section>
          <section class="dashboard-grid">
            <article class="panel chart-panel">
              <div class="panel-heading">
                <div><p class="eyebrow">30 days</p><h2>Visitor trend</h2></div>
                <span class="chart-key"><i></i> Visitors</span>
              </div>
              <div id="chartWrap" class="chart-wrap" aria-label="30 day visitors line chart"></div>
            </article>
            <article class="panel category-panel">
              <div class="panel-heading"><div><p class="eyebrow">Breakdown</p><h2>Categories</h2></div></div>
              <div class="bars">${categoryBars(state.categories)}</div>
            </article>
          </section>
          <section class="panel table-panel">
            <div class="panel-heading"><div><p class="eyebrow">Latest</p><h2>Recent items</h2></div></div>
            ${recentTable(state.recent)}
          </section>
        </main>
      `}
    </div>
  `;

  document.querySelector('#themeToggle')?.addEventListener('click', toggleTheme);
  document.querySelector('#retryLoad')?.addEventListener('click', init);

  if (!error) {
    setupChartResize();
    drawChart();
  }
}

function categoryBars(items) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return items.map((item) => {
    const pct = Math.max(8, (item.value / max) * 100);
    return `
      <div class="bar-row">
        <div class="bar-meta">
          <span class="bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
          <strong class="bar-value">${numberFmt.format(item.value)}</strong>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('');
}

function recentTable(items) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
        <tbody>
          ${items.map((item) => `
            <tr>
              <td data-label="Name"><span class="cell-main">${escapeHtml(item.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
              <td data-label="Value">${numberFmt.format(item.value)}</td>
              <td data-label="Created">${dateFmt.format(new Date(item.created_at))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (err) {
    console.error(err);
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
    alert('Unable to persist theme preference.');
  }
}

function setupChartResize() {
  const wrap = document.querySelector('#chartWrap');
  if (!wrap || !('ResizeObserver' in window)) {
    window.addEventListener('resize', drawChart, { passive: true });
    return;
  }
  state.chartObserver?.disconnect();
  state.chartObserver = new ResizeObserver(() => drawChart());
  state.chartObserver.observe(wrap);
}

function drawChart() {
  const wrap = document.querySelector('#chartWrap');
  if (!wrap || !state.series.length) return;
  const rect = wrap.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(250, Math.floor(rect.height || 320));
  const isSmall = width < 430;
  const margin = { top: 22, right: isSmall ? 18 : 28, bottom: 48, left: isSmall ? 44 : 64 };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = Math.max(10, height - margin.top - margin.bottom);
  const values = state.series.map((d) => d.visitors);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(500, (max - min) * 0.12);
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const x = (i) => margin.left + (i / (state.series.length - 1)) * plotW;
  const y = (v) => margin.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const pointPath = state.series.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ');
  const areaPath = `${pointPath} L ${margin.left + plotW} ${margin.top + plotH} L ${margin.left} ${margin.top + plotH} Z`;
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) / 4) * i);
  const xTickIndexes = isSmall ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const css = getComputedStyle(document.documentElement);
  const colors = {
    axis: css.getPropertyValue('--axis').trim(),
    grid: css.getPropertyValue('--grid').trim(),
    text: css.getPropertyValue('--muted').trim(),
    line: css.getPropertyValue('--series').trim(),
    fill: css.getPropertyValue('--series-fill').trim()
  };

  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chartTitle chartDesc" preserveAspectRatio="none">
      <title id="chartTitle">Thirty day visitor trend</title>
      <desc id="chartDesc">Line chart of visitors for each seeded day.</desc>
      <rect width="${width}" height="${height}" fill="transparent" />
      ${yTicks.map((tick) => {
        const yy = y(tick);
        return `<line x1="${margin.left}" x2="${margin.left + plotW}" y1="${yy}" y2="${yy}" stroke="${colors.grid}" stroke-width="1" />
          <text x="${margin.left - 10}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${colors.text}">${compactFmt.format(tick)}</text>`;
      }).join('')}
      <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotH}" stroke="${colors.axis}" />
      <line x1="${margin.left}" x2="${margin.left + plotW}" y1="${margin.top + plotH}" y2="${margin.top + plotH}" stroke="${colors.axis}" />
      ${xTickIndexes.map((idx) => {
        const xx = x(idx);
        const label = dateFmt.format(new Date(`${state.series[idx].date}T00:00:00Z`));
        return `<line x1="${xx}" x2="${xx}" y1="${margin.top + plotH}" y2="${margin.top + plotH + 5}" stroke="${colors.axis}" />
          <text x="${xx}" y="${height - 18}" text-anchor="middle" font-size="11" fill="${colors.text}">${label}</text>`;
      }).join('')}
      <path d="${areaPath}" fill="${colors.fill}" />
      <path d="${pointPath}" fill="none" stroke="${colors.line}" stroke-linecap="round" stroke-linejoin="round" stroke-width="3" />
      ${state.series.map((d, i) => i % (isSmall ? 10 : 6) === 0 || i === state.series.length - 1 ? `<circle cx="${x(i)}" cy="${y(d.visitors)}" r="3" fill="${colors.line}" />` : '').join('')}
    </svg>
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function init() {
  app.innerHTML = `<div class="loading"><div class="spinner"></div><p>Loading dashboard data…</p></div>`;
  try {
    await loadSettingsBeforeRender();
    const [summary, series, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent')
    ]);
    Object.assign(state, { summary, series, categories, recent });
    shell();
  } catch (err) {
    console.error(err);
    shell({ error: 'Start the metrics API server and retry. No hardcoded dashboard data is shown when the API is unavailable.' });
  }
}

init();
