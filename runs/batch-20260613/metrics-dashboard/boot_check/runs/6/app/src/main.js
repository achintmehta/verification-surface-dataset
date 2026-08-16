const $ = (selector) => document.querySelector(selector);
const statsGrid = $('#statsGrid');
const chartShell = $('#timeChart');
const categoryBars = $('#categoryBars');
const recentBody = $('#recentBody');
const errorState = $('#errorState');
const themeToggle = $('#themeToggle');

const formatInt = new Intl.NumberFormat('en-US');
const formatCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const formatCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const formatDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

let chartData = [];
let resizeObserver;

function api(path) {
  return fetch(path, { headers: { Accept: 'application/json' } }).then((response) => {
    if (!response.ok) throw new Error(`Request failed: ${path}`);
    return response.json();
  });
}

function setTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  themeToggle.setAttribute('aria-pressed', String(normalized === 'dark'));
  themeToggle.querySelector('.toggle-text').textContent = normalized === 'dark' ? 'Light mode' : 'Dark mode';
  drawChart();
}

function statCard({ label, value, detail, trend }) {
  const article = document.createElement('article');
  article.className = 'card stat-card';
  const trendClass = trend >= 0 ? 'positive' : 'negative';
  const trendText = trend === undefined ? detail : `${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}% vs prior 7 days`;
  article.innerHTML = `
    <span class="stat-label">${label}</span>
    <strong class="stat-value">${value}</strong>
    <span class="stat-detail ${trend !== undefined ? trendClass : ''}">${trendText}</span>
  `;
  return article;
}

function renderSummary(summary) {
  statsGrid.replaceChildren(
    statCard({ label: 'Total visitors', value: formatInt.format(summary.totalVisitors), detail: 'Across seeded 30-day period' }),
    statCard({ label: 'Total revenue', value: formatCurrency.format(summary.totalRevenue), detail: 'Recognized dashboard revenue' }),
    statCard({ label: 'Best day', value: formatInt.format(summary.bestDay.visitors), detail: `${formatDay.format(new Date(summary.bestDay.date))} visitors` }),
    statCard({ label: '7-day trend', value: `${summary.sevenDayTrendPct >= 0 ? '+' : ''}${summary.sevenDayTrendPct.toFixed(1)}%`, trend: summary.sevenDayTrendPct })
  );
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceTicks(min, max, count = 4) {
  if (min === max) return [min];
  const span = max - min;
  const step0 = Math.pow(10, Math.floor(Math.log10(span / count)));
  const error = span / count / step0;
  const step = error >= 7.5 ? step0 * 10 : error >= 3.5 ? step0 * 5 : error >= 1.5 ? step0 * 2 : step0;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(v);
  return ticks;
}

function drawChart() {
  if (!chartShell || chartData.length === 0 || chartShell.clientWidth === 0) return;
  const width = Math.max(300, Math.floor(chartShell.clientWidth));
  const height = Math.max(250, Math.floor(chartShell.clientHeight || 310));
  const isNarrow = width < 460;
  const margin = { top: 20, right: isNarrow ? 18 : 30, bottom: isNarrow ? 58 : 50, left: isNarrow ? 48 : 64 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const visitors = chartData.map((d) => d.visitors);
  const minY = Math.min(...visitors) * 0.94;
  const maxY = Math.max(...visitors) * 1.04;
  const ticks = niceTicks(minY, maxY, 4);
  const x = (i) => margin.left + (i / (chartData.length - 1)) * innerW;
  const y = (v) => margin.top + (1 - (v - ticks[0]) / (ticks[ticks.length - 1] - ticks[0])) * innerH;
  const points = chartData.map((d, i) => `${x(i).toFixed(2)},${y(d.visitors).toFixed(2)}`).join(' ');
  const area = `${margin.left},${margin.top + innerH} ${points} ${margin.left + innerW},${margin.top + innerH}`;
  const labelIndexes = isNarrow ? [0, 14, 29] : [0, 7, 14, 21, 29];

  const grid = ticks.map((t) => {
    const yy = y(t);
    return `<g><line class="grid-line" x1="${margin.left}" x2="${margin.left + innerW}" y1="${yy}" y2="${yy}" />
      <text class="axis-label" x="${margin.left - 10}" y="${yy + 4}" text-anchor="end">${formatCompact.format(t)}</text></g>`;
  }).join('');

  const xLabels = labelIndexes.map((i) => {
    const xx = x(i);
    return `<g><line class="tick-line" x1="${xx}" x2="${xx}" y1="${margin.top + innerH}" y2="${margin.top + innerH + 6}" />
      <text class="axis-label" x="${xx}" y="${margin.top + innerH + 24}" text-anchor="middle">${formatDay.format(new Date(chartData[i].date))}</text></g>`;
  }).join('');

  chartShell.innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="Visitors over the past 30 days">
      <rect class="plot-bg" x="${margin.left}" y="${margin.top}" width="${innerW}" height="${innerH}" rx="10" />
      ${grid}
      <line class="axis-line" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + innerH}" />
      <line class="axis-line" x1="${margin.left}" x2="${margin.left + innerW}" y1="${margin.top + innerH}" y2="${margin.top + innerH}" />
      ${xLabels}
      <polygon class="chart-area" points="${area}" />
      <polyline class="chart-line" points="${points}" />
      ${chartData.map((d, i) => `<circle class="chart-dot" cx="${x(i)}" cy="${y(d.visitors)}" r="${i === chartData.length - 1 ? 4 : 2.6}"><title>${d.date}: ${formatInt.format(d.visitors)} visitors, ${formatCurrency.format(d.revenue)}</title></circle>`).join('')}
      <text class="chart-caption" x="${margin.left}" y="${height - 10}">Visitors plotted; hover points for revenue</text>
    </svg>`;
}

function renderCategories(categories) {
  const max = Math.max(...categories.map((c) => c.value));
  categoryBars.replaceChildren(...categories.map((cat) => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-meta">
        <span class="bar-label" title="${cat.label}">${cat.label}</span>
        <span class="bar-value">${formatInt.format(cat.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${Math.max(8, (cat.value / max) * 100)}%"></span></div>
    `;
    return row;
  }));
}

function renderRecent(items) {
  recentBody.replaceChildren(...items.map((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Name"><span class="cell-strong">${item.name}</span></td>
      <td data-label="Category"><span class="truncate" title="${item.category}">${item.category}</span></td>
      <td data-label="Value">${formatCurrency.format(item.value)}</td>
      <td data-label="Created">${formatDay.format(new Date(item.createdAt))}</td>
    `;
    return tr;
  }));
}

function showError(error) {
  console.error(error);
  errorState.hidden = false;
  statsGrid.replaceChildren();
  chartShell.innerHTML = '<div class="empty-panel">No chart data loaded.</div>';
  categoryBars.innerHTML = '<div class="empty-panel">No category data loaded.</div>';
  recentBody.replaceChildren();
}

async function init() {
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      api('/api/settings'),
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent')
    ]);
    setTheme(settings.theme);
    renderSummary(summary);
    chartData = timeseries;
    drawChart();
    renderCategories(categories);
    renderRecent(recent);
    errorState.hidden = true;
  } catch (error) {
    showError(error);
  }
}

themeToggle.addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  } catch (error) {
    showError(error);
  }
});

resizeObserver = new ResizeObserver(() => drawChart());
resizeObserver.observe(chartShell);
window.addEventListener('resize', drawChart, { passive: true });

init();
