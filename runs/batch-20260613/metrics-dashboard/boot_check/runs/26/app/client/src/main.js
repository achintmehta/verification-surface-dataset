const API_BASE = 'http://localhost:3000/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSettings() {
  try {
    const { theme } = await fetchJSON(`${API_BASE}/settings`);
    return theme || 'light';
  } catch {
    return 'light';
  }
}

async function saveTheme(theme) {
  try {
    await fetchJSON(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  currentTheme = theme;
}

async function initTheme() {
  const theme = await loadSettings();
  applyTheme(theme);
}

function setupThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
    // Redraw chart with new theme colors
    await renderTimeseries();
  });
}

async function loadDashboard() {
  const errorBanner = document.getElementById('error-banner');
  errorBanner.classList.add('hidden');

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`)
    ]);

    renderStats(summary);
    await renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecentTable(recent);

    // Setup resize handler for chart
    setupResizeHandler(timeseries);
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    errorBanner.textContent = 'Unable to load data from server. Please ensure the backend is running.';
    errorBanner.classList.remove('hidden');
  }
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + parseFloat(summary.totalRevenue).toLocaleString();
  document.getElementById('best-day').textContent = summary.bestDay;
  document.getElementById('best-day-visitors').textContent = summary.bestDayVisitors.toLocaleString() + ' visitors';
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

async function renderTimeseries(dataOverride = null) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

  let data;
  if (dataOverride) {
    data = dataOverride;
  } else {
    try {
      data = await fetchJSON(`${API_BASE}/timeseries`);
    } catch {
      return;
    }
  }

  // Clear previous content
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  const margin = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  if (!data || data.length === 0) return;

  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const yRange = maxVisitors - minVisitors || 1;

  const getX = (i) => margin.left + (i / (data.length - 1)) * chartWidth;
  const getY = (v) => margin.top + chartHeight - ((v - minVisitors) / yRange) * chartHeight;

  // Grid lines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const yVal = minVisitors + (yRange * i / yTicks);
    const y = getY(yVal);

    // Grid line
    const gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    gridLine.setAttribute('x1', margin.left);
    gridLine.setAttribute('y1', y);
    gridLine.setAttribute('x2', margin.left + chartWidth);
    gridLine.setAttribute('y2', y);
    gridLine.setAttribute('stroke', 'var(--chart-grid)');
    gridLine.setAttribute('stroke-width', '1');
    svg.appendChild(gridLine);

    // Y tick label
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', margin.left - 10);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', 'var(--chart-axis)');
    label.setAttribute('font-size', '11');
    label.textContent = Math.round(yVal).toLocaleString();
    svg.appendChild(label);
  }

  // X axis line
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', margin.left);
  xAxis.setAttribute('y1', margin.top + chartHeight);
  xAxis.setAttribute('x2', margin.left + chartWidth);
  xAxis.setAttribute('y2', margin.top + chartHeight);
  xAxis.setAttribute('stroke', 'var(--chart-axis)');
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  // X ticks - show every 5 days
  for (let i = 0; i < data.length; i += 5) {
    const x = getX(i);
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('y1', margin.top + chartHeight);
    tick.setAttribute('x2', x);
    tick.setAttribute('y2', margin.top + chartHeight + 6);
    tick.setAttribute('stroke', 'var(--chart-axis)');
    tick.setAttribute('stroke-width', '1');
    svg.appendChild(tick);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', margin.top + chartHeight + 20);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'var(--chart-axis)');
    label.setAttribute('font-size', '10');
    label.textContent = data[i].date.slice(5); // MM-DD
    svg.appendChild(label);
  }

  // Line path
  let pathD = `M ${getX(0)} ${getY(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    pathD += ` L ${getX(i)} ${getY(data[i].visitors)}`;
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--chart-line)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Dots
  for (let i = 0; i < data.length; i += 3) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', getX(i));
    dot.setAttribute('cy', getY(data[i].visitors));
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(dot);
  }
}

function setupResizeHandler(data) {
  const container = document.getElementById('timeseries-container');
  if (!container) return;

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      renderTimeseries(data);
    }, 150);
  });
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  if (!categories || categories.length === 0) return;

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const header = document.createElement('div');
    header.className = 'category-header';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // for tooltip on long names

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    header.appendChild(name);
    header.appendChild(value);

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    const percent = (cat.value / maxValue) * 100;
    bar.style.width = percent + '%';

    barContainer.appendChild(bar);

    item.appendChild(header);
    item.appendChild(barContainer);
    container.appendChild(item);
  });
}

function renderRecentTable(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${item.created_at.split(' ')[0]}</td>
    `;
    tbody.appendChild(row);
  });
}

async function main() {
  await initTheme();
  setupThemeToggle();
  await loadDashboard();
}

main();