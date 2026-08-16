import { getSummary, getTimeseries, getCategories, getRecent } from './api.js';
import { drawTimeseriesChart, setupChartResize } from './chart.js';
import { loadTheme, initThemeToggle, setThemeChangeCallback } from './theme.js';

let timeseriesData = null;
let chartCleanup = null;

// Format number with commas
function formatNumber(num) {
  if (num == null) return '—';
  return Number(num).toLocaleString('en-US');
}

// Format currency
function formatCurrency(num) {
  if (num == null) return '—';
  return '$' + Number(num).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

// Format date
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Format short date
function formatShortDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function showLoading() {
  document.getElementById('loading-state').style.display = 'flex';
  document.getElementById('error-state').style.display = 'none';
  document.getElementById('dashboard-content').style.display = 'none';
}

function showError() {
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('error-state').style.display = 'flex';
  document.getElementById('dashboard-content').style.display = 'none';
}

function showDashboard() {
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('error-state').style.display = 'none';
  document.getElementById('dashboard-content').style.display = 'block';
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);

  if (summary.bestDay) {
    document.getElementById('stat-best-day').textContent = formatNumber(summary.bestDay.visitors) + ' visitors';
    document.getElementById('stat-best-day-date').textContent = formatShortDate(summary.bestDay.date);
  }

  const trendVal = summary.trendPct;
  const trendEl = document.getElementById('stat-trend');
  const trendIndicator = document.getElementById('trend-indicator');
  const isPositive = trendVal >= 0;

  trendEl.textContent = (isPositive ? '+' : '') + trendVal + '%';
  trendIndicator.textContent = isPositive ? '▲ Trending up' : '▼ Trending down';
  trendIndicator.className = 'stat-sub trend-indicator ' + (isPositive ? 'positive' : 'negative');
}

function renderChart(data) {
  timeseriesData = data;
  const svg = document.getElementById('timeseries-chart');

  // Clean up previous resize observer
  if (chartCleanup) {
    chartCleanup();
  }

  drawTimeseriesChart(svg, data);
  chartCleanup = setupChartResize(svg, data);
}

function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';

  if (!categories || categories.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary);">No categories found.</p>';
    return;
  }

  const maxVal = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const header = document.createElement('div');
    header.className = 'category-header';

    const name = document.createElement('span');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name;

    const value = document.createElement('span');
    value.className = 'category-value';
    value.textContent = formatNumber(cat.value);

    header.appendChild(name);
    header.appendChild(value);

    const barBg = document.createElement('div');
    barBg.className = 'category-bar-bg';

    const barFill = document.createElement('div');
    barFill.className = 'category-bar-fill';
    barFill.style.width = ((cat.value / maxVal) * 100) + '%';

    barBg.appendChild(barFill);
    item.appendChild(header);
    item.appendChild(barBg);
    container.appendChild(item);
  });
}

function renderRecentItems(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  if (!items || items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.setAttribute('colspan', '4');
    td.textContent = 'No recent items found.';
    td.style.textAlign = 'center';
    td.style.color = 'var(--text-secondary)';
    td.style.padding = '2rem';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  items.forEach(item => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    tdName.title = item.name;

    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;
    tdCat.title = item.category;

    const tdVal = document.createElement('td');
    tdVal.textContent = '$' + Number(item.value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const tdDate = document.createElement('td');
    tdDate.textContent = formatDate(item.createdAt);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    tbody.appendChild(tr);
  });
}

async function loadDashboard() {
  showLoading();

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);

    renderSummary(summary);
    renderCategories(categories);
    renderRecentItems(recent);
    showDashboard();

    // Render chart after DOM is visible so container has dimensions
    requestAnimationFrame(() => {
      renderChart(timeseries);
    });
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    showError();
  }
}

// When theme changes, redraw chart with new colors
setThemeChangeCallback(() => {
  if (timeseriesData) {
    const svg = document.getElementById('timeseries-chart');
    drawTimeseriesChart(svg, timeseriesData);
  }
});

// Initialize
async function init() {
  // Load theme first (before paint)
  await loadTheme();
  initThemeToggle();

  // Load dashboard data
  await loadDashboard();

  // Retry button
  document.getElementById('retry-btn').addEventListener('click', loadDashboard);
}

init();
