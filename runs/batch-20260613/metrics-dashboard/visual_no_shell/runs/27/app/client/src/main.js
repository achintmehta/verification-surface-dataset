const API_BASE = '/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  try {
    const [summary, timeseries, categories, recent, settings] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`),
      fetchJSON(`${API_BASE}/settings`)
    ]);

    // Apply persisted theme
    applyTheme(settings.theme || 'light');

    // Render all sections
    renderStats(summary);
    renderTimeseriesChart(timeseries);
    renderCategoryBars(categories);
    renderRecentTable(recent);

    // Hide error banner
    document.getElementById('error-banner').style.display = 'none';

    // Setup resize handler for chart
    setupResizeHandler(timeseries);
  } catch (err) {
    console.error('Failed to load data:', err);
    document.getElementById('error-banner').style.display = 'block';
    // Show empty states
    showEmptyStates();
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);

  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to persist theme:', err);
  }
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();

  const bestDayEl = document.getElementById('best-day');
  if (summary.bestDay) {
    const date = new Date(summary.bestDay);
    bestDayEl.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } else {
    bestDayEl.textContent = 'N/A';
  }

  document.getElementById('best-day-visitors').textContent = summary.bestDayVisitors 
    ? summary.bestDayVisitors.toLocaleString() + ' visitors' 
    : '';

  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

function renderTimeseriesChart(data) {
  const container = document.getElementById('timeseries-chart');
  container.innerHTML = '';

  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 40px; text-align: center;">No data available</p>';
    return;
  }

  const svg = createTimeseriesSVG(data, container.clientWidth || 600, container.clientHeight || 320);
  container.appendChild(svg);
}

function createTimeseriesSVG(data, width, height) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const visitors = data.map(d => d.visitors);
  const maxVal = Math.max(...visitors);
  const minVal = Math.min(...visitors);
  const range = maxVal - minVal || 1;

  // Grid lines and Y axis labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartHeight * i / yTicks);
    const val = Math.round(maxVal - (range * i / yTicks));

    // Grid line
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y label
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', padding.left - 10);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', 'var(--chart-axis)');
    label.setAttribute('font-size', '11');
    label.textContent = val.toLocaleString();
    svg.appendChild(label);
  }

  // X axis labels (dates) - show ~6 labels
  const xStep = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += xStep) {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const date = new Date(data[i].date);
    const labelText = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', height - padding.bottom + 20);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'var(--chart-axis)');
    label.setAttribute('font-size', '10');
    label.textContent = labelText;
    svg.appendChild(label);

    // Tick
    const tick = document.createElementNS(svgNS, 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('y1', height - padding.bottom);
    tick.setAttribute('x2', x);
    tick.setAttribute('y2', height - padding.bottom + 5);
    tick.setAttribute('stroke', 'var(--chart-axis)');
    tick.setAttribute('stroke-width', '1');
    svg.appendChild(tick);
  }

  // X axis line
  const xAxis = document.createElementNS(svgNS, 'line');
  xAxis.setAttribute('x1', padding.left);
  xAxis.setAttribute('y1', height - padding.bottom);
  xAxis.setAttribute('x2', width - padding.right);
  xAxis.setAttribute('y2', height - padding.bottom);
  xAxis.setAttribute('stroke', 'var(--chart-axis)');
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  // Y axis line
  const yAxis = document.createElementNS(svgNS, 'line');
  yAxis.setAttribute('x1', padding.left);
  yAxis.setAttribute('y1', padding.top);
  yAxis.setAttribute('x2', padding.left);
  yAxis.setAttribute('y2', height - padding.bottom);
  yAxis.setAttribute('stroke', 'var(--chart-axis)');
  yAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(yAxis);

  // Line path for series
  let pathD = '';
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVal) / range);
    pathD += (i === 0 ? 'M' : 'L') + `${x},${y} `;
  });

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', pathD.trim());
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--chart-line)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Dots
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVal) / range);

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });

  return svg;
}

function setupResizeHandler(data) {
  const container = document.getElementById('timeseries-chart');

  const handleResize = () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      renderTimeseriesChart(data);
    }, 150);
  };

  window.addEventListener('resize', handleResize);

  // Store reference to remove if needed, but for SPA ok
}

function renderCategoryBars(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';

  if (!categories || categories.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No categories</p>';
    return;
  }

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const header = document.createElement('div');
    header.className = 'category-header';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // full name on hover

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    header.appendChild(name);
    header.appendChild(value);

    const barContainer = document.createElement('div');
    barContainer.className = 'bar-container';

    const bar = document.createElement('div');
    bar.className = 'bar';
    const percent = (cat.value / maxValue) * 100;
    bar.style.width = percent + '%';

    barContainer.appendChild(bar);

    item.appendChild(header);
    item.appendChild(barContainer);
    container.appendChild(item);
  });
}

function renderRecentTable(items) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';

  if (!items || items.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="4" style="text-align:center; color:var(--text-muted);">No recent items</td>`;
    tbody.appendChild(row);
    return;
  }

  items.forEach(item => {
    const row = document.createElement('tr');
    const date = new Date(item.created_at);
    const dateStr = date.toLocaleDateString();

    row.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${dateStr}</td>
    `;
    tbody.appendChild(row);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

function showEmptyStates() {
  document.getElementById('total-visitors').textContent = '—';
  document.getElementById('total-revenue').textContent = '—';
  document.getElementById('best-day').textContent = '—';
  document.getElementById('seven-day-trend').textContent = '—';

  const chartContainer = document.getElementById('timeseries-chart');
  chartContainer.innerHTML = '<p style="color: var(--text-muted); padding: 60px 20px; text-align: center;">Connect to backend to load chart data</p>';

  document.getElementById('category-bars').innerHTML = '<p style="color: var(--text-muted);">No data</p>';
  document.querySelector('#recent-table tbody').innerHTML = 
    '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No data</td></tr>';
}

function initThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', toggleTheme);
}

async function init() {
  initThemeToggle();
  await loadData();
}

init();