import './styles.css';

const app = document.querySelector('#app');
const API = '';

const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: 'light',
  chartObserver: null,
};

const numberFormat = new Intl.NumberFormat('en-US');
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function formatDate(iso) {
  return shortDate.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function fetchJson(url, options) {
  const response = await fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}`);
  }
  return response.json();
}

function setTheme(theme, persistLocal = true) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  if (persistLocal) {
    try {
      localStorage.setItem('metrics-dashboard-theme', state.theme);
    } catch (error) {
      // localStorage can be unavailable in hardened browsers.
    }
  }
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.checked = state.theme === 'dark';
    toggle.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
  }
  drawLineChart();
}

function showLoading() {
  app.innerHTML = `
    <main class="app-shell loading-shell" aria-busy="true">
      <section class="empty-state">
        <div class="spinner" aria-hidden="true"></div>
        <h1>Loading metrics dashboard…</h1>
        <p>Fetching seeded metrics from the API.</p>
      </section>
    </main>
  `;
}

function showError(error) {
  app.innerHTML = `
    <main class="app-shell">
      <section class="empty-state error-state" role="alert">
        <span class="status-dot"></span>
        <h1>Dashboard data unavailable</h1>
        <p>The dashboard could not load live API data. Start the backend server and refresh the page.</p>
        <code>${escapeHtml(error.message || 'Unknown API error')}</code>
        <button class="primary-button" id="retryButton" type="button">Retry</button>
      </section>
    </main>
  `;
  document.querySelector('#retryButton')?.addEventListener('click', boot);
}

function renderStatCards() {
  const { totalVisitors, totalRevenue, bestDay, sevenDayTrendPercent } = state.summary;
  const trendClass = sevenDayTrendPercent >= 0 ? 'positive' : 'negative';
  const trendText = `${percentFormat.format(sevenDayTrendPercent)}%`;
  const cards = [
    {
      label: 'Total visitors',
      value: numberFormat.format(totalVisitors),
      meta: '30-day audience reach',
      chip: 'Visitors',
    },
    {
      label: 'Total revenue',
      value: moneyFormat.format(totalRevenue),
      meta: 'Recognized revenue',
      chip: 'Revenue',
    },
    {
      label: 'Best day',
      value: formatDate(bestDay.date),
      meta: `${moneyFormat.format(bestDay.revenue)} · ${numberFormat.format(bestDay.visitors)} visitors`,
      chip: 'Peak',
    },
    {
      label: '7-day trend',
      value: trendText,
      meta: 'Visitors vs previous 7 days',
      chip: sevenDayTrendPercent >= 0 ? 'Up' : 'Down',
      trendClass,
    },
  ];

  return cards
    .map(
      (card) => `
        <article class="stat-card ${card.trendClass || ''}">
          <div class="stat-card__top">
            <span class="stat-label">${escapeHtml(card.label)}</span>
            <span class="stat-chip">${escapeHtml(card.chip)}</span>
          </div>
          <strong class="stat-value" title="${escapeHtml(card.value)}">${escapeHtml(card.value)}</strong>
          <span class="stat-meta">${escapeHtml(card.meta)}</span>
        </article>
      `
    )
    .join('');
}

function renderCategories() {
  const max = Math.max(...state.categories.map((category) => category.value), 1);
  return state.categories
    .map((category) => {
      const width = Math.max(6, (category.value / max) * 100);
      return `
        <li class="bar-row">
          <div class="bar-row__meta">
            <span class="bar-label" title="${escapeHtml(category.label)}">${escapeHtml(category.label)}</span>
            <span class="bar-value">${numberFormat.format(category.value)}</span>
          </div>
          <div class="bar-track" aria-hidden="true">
            <span class="bar-fill" style="width: ${width}%"></span>
          </div>
        </li>
      `;
    })
    .join('');
}

function renderRecentRows() {
  return state.recent
    .map(
      (item) => `
        <tr>
          <td data-label="Name"><span class="row-title">${escapeHtml(item.name)}</span></td>
          <td data-label="Category"><span class="truncate" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
          <td data-label="Value" class="numeric">${numberFormat.format(item.value)}</td>
          <td data-label="Created">${escapeHtml(formatDate(item.created_at.slice(0, 10)))}</td>
        </tr>
      `
    )
    .join('');
}

function renderDashboard() {
  app.innerHTML = `
    <main class="app-shell">
      <header class="dashboard-header">
        <div class="title-block">
          <span class="eyebrow">Seeded analytics</span>
          <h1>Metrics Dashboard</h1>
          <p>Thirty days of deterministic PGLite metrics rendered with responsive, hand-drawn charts.</p>
        </div>
        <label class="theme-switch">
          <span>Light</span>
          <input id="themeToggle" type="checkbox" ${state.theme === 'dark' ? 'checked' : ''} />
          <span class="switch-ui" aria-hidden="true"></span>
          <span>Dark</span>
        </label>
      </header>

      <section class="stats-grid" aria-label="Summary metrics">
        ${renderStatCards()}
      </section>

      <section class="dashboard-grid">
        <article class="panel chart-panel">
          <div class="panel-heading">
            <div>
              <h2>30-day visitors</h2>
              <p>Line chart redraws to fit its card.</p>
            </div>
            <span class="panel-kicker">${state.timeseries.length} days</span>
          </div>
          <div id="chartContainer" class="chart-container" aria-label="30-day visitors line chart" role="img"></div>
        </article>

        <article class="panel category-panel">
          <div class="panel-heading">
            <div>
              <h2>Category breakdown</h2>
              <p>Long labels truncate before the bars.</p>
            </div>
          </div>
          <ul class="bars-list">
            ${renderCategories()}
          </ul>
        </article>
      </section>

      <section class="panel table-panel">
        <div class="panel-heading">
          <div>
            <h2>Recent items</h2>
            <p>Latest seeded records from the API.</p>
          </div>
        </div>
        <div class="responsive-table">
          <table>
            <thead>
              <tr><th>Name</th><th>Category</th><th class="numeric">Value</th><th>Created</th></tr>
            </thead>
            <tbody>${renderRecentRows()}</tbody>
          </table>
        </div>
      </section>
    </main>
  `;

  document.querySelector('#themeToggle')?.addEventListener('change', handleThemeChange);
  setTheme(state.theme, true);
  setupChartObserver();
}

async function handleThemeChange(event) {
  const nextTheme = event.target.checked ? 'dark' : 'light';
  setTheme(nextTheme, true);
  try {
    await fetchJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: nextTheme }),
    });
  } catch (error) {
    console.error('Unable to persist theme', error);
  }
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function createSvgElement(name, attrs = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function drawLineChart() {
  const container = document.querySelector('#chartContainer');
  if (!container || !state.timeseries.length) return;

  const rect = container.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(250, Math.floor(rect.height || 330));
  const margin = width < 420 ? { top: 18, right: 14, bottom: 54, left: 54 } : { top: 18, right: 22, bottom: 50, left: 66 };
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = Math.max(10, height - margin.top - margin.bottom);

  const values = state.timeseries.map((point) => point.visitors);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const padding = Math.max(500, (maxValue - minValue) * 0.12);
  const yMin = Math.max(0, minValue - padding);
  const yMax = maxValue + padding;
  const yRange = Math.max(1, yMax - yMin);

  const xFor = (index) => margin.left + (state.timeseries.length === 1 ? 0 : (index / (state.timeseries.length - 1)) * plotWidth);
  const yFor = (value) => margin.top + (1 - (value - yMin) / yRange) * plotHeight;
  const points = state.timeseries.map((point, index) => `${xFor(index).toFixed(2)},${yFor(point.visitors).toFixed(2)}`).join(' ');

  const svg = createSvgElement('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height: '100%',
    preserveAspectRatio: 'none',
    class: 'line-chart',
  });

  const gridColor = getCssVar('--chart-grid');
  const axisColor = getCssVar('--chart-axis');
  const textColor = getCssVar('--muted-text');
  const seriesColor = getCssVar('--series');
  const fillColor = getCssVar('--series-fill');

  for (let i = 0; i <= 4; i += 1) {
    const y = margin.top + (i / 4) * plotHeight;
    const value = yMax - (i / 4) * yRange;
    svg.appendChild(createSvgElement('line', { x1: margin.left, y1: y, x2: width - margin.right, y2: y, stroke: gridColor, 'stroke-width': 1 }));
    const label = createSvgElement('text', { x: margin.left - 8, y: y + 4, 'text-anchor': 'end', fill: textColor, 'font-size': width < 420 ? 10 : 11 });
    label.textContent = compactFormat.format(value);
    svg.appendChild(label);
  }

  const tickIndexes = width < 420 ? [0, 14, 29] : [0, 7, 14, 21, 29];
  tickIndexes.forEach((index) => {
    const x = xFor(index);
    svg.appendChild(createSvgElement('line', { x1: x, y1: margin.top, x2: x, y2: height - margin.bottom, stroke: gridColor, 'stroke-width': 1 }));
    const label = createSvgElement('text', { x, y: height - 18, 'text-anchor': index === 0 ? 'start' : index === 29 ? 'end' : 'middle', fill: textColor, 'font-size': width < 420 ? 10 : 11 });
    label.textContent = formatDate(state.timeseries[index].date);
    svg.appendChild(label);
  });

  svg.appendChild(createSvgElement('line', { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, stroke: axisColor, 'stroke-width': 1.25 }));
  svg.appendChild(createSvgElement('line', { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, stroke: axisColor, 'stroke-width': 1.25 }));

  const areaPath = createSvgElement('path', {
    d: `M ${margin.left} ${height - margin.bottom} L ${points.replaceAll(' ', ' L ')} L ${width - margin.right} ${height - margin.bottom} Z`,
    fill: fillColor,
  });
  svg.appendChild(areaPath);
  svg.appendChild(createSvgElement('polyline', { points, fill: 'none', stroke: seriesColor, 'stroke-width': width < 420 ? 2.5 : 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  state.timeseries.forEach((point, index) => {
    if (index % 5 === 0 || index === state.timeseries.length - 1) {
      svg.appendChild(createSvgElement('circle', { cx: xFor(index), cy: yFor(point.visitors), r: width < 420 ? 2.4 : 3.2, fill: getCssVar('--card-bg'), stroke: seriesColor, 'stroke-width': 2 }));
    }
  });

  container.replaceChildren(svg);
}

function setupChartObserver() {
  state.chartObserver?.disconnect();
  const container = document.querySelector('#chartContainer');
  if (!container) return;
  state.chartObserver = new ResizeObserver(() => drawLineChart());
  state.chartObserver.observe(container);
  drawLineChart();
}

async function boot() {
  showLoading();
  try {
    const settings = await fetchJson('/api/settings');
    setTheme(settings.theme, true);
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/api/summary'),
      fetchJson('/api/timeseries'),
      fetchJson('/api/categories'),
      fetchJson('/api/recent'),
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    renderDashboard();
  } catch (error) {
    showError(error);
  }
}

boot();
