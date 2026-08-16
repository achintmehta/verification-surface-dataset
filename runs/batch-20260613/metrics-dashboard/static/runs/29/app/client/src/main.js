const API_BASE = '/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchData() {
  try {
    const [summary, timeseries, categories, recent, settings] = await Promise.all([
      fetch(`${API_BASE}/summary`).then(r => r.json()),
      fetch(`${API_BASE}/timeseries`).then(r => r.json()),
      fetch(`${API_BASE}/categories`).then(r => r.json()),
      fetch(`${API_BASE}/recent`).then(r => r.json()),
      fetch(`${API_BASE}/settings`).then(r => r.json())
    ]);

    return { summary, timeseries, categories, recent, settings };
  } catch (err) {
    showError('Failed to load dashboard data. Is the backend running?');
    throw err;
  }
}

function showError(message) {
  const banner = document.getElementById('error-banner');
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function hideError() {
  const banner = document.getElementById('error-banner');
  banner.classList.add('hidden');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  currentTheme = theme;
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
    console.error('Failed to persist theme', err);
  }
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
  document.getElementById('best-day').textContent = summary.bestDay || '-';
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? '#22c55e' : '#ef4444';
}

function drawTimeSeriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

  // Clear previous content
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  if (!data || data.length === 0) return;

  const values = data.map(d => d.visitors);
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const range = maxVal - minVal || 1;

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Gridlines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartHeight * i / yTicks);
    const val = Math.round(maxVal - (range * i / yTicks));

    // Grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', padding.left - 10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', 'var(--chart-axis)');
    text.setAttribute('font-size', '11');
    text.textContent = val.toLocaleString();
    svg.appendChild(text);
  }

  // X axis labels (every 5 days)
  const xStep = Math.floor(data.length / 6) || 1;
  for (let i = 0; i < data.length; i += xStep) {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const date = data[i].date;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', padding.top);
    line.setAttribute('x2', x);
    line.setAttribute('y2', height - padding.bottom);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - padding.bottom + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', 'var(--chart-axis)');
    text.setAttribute('font-size', '10');
    text.textContent = date.slice(5); // MM-DD
    svg.appendChild(text);
  }

  // Draw the line
  let pathD = '';
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVal) / range);
    pathD += (i === 0 ? 'M' : 'L') + `${x},${y} `;
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
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

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
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

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // for tooltip on long names

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    const percent = (cat.value / maxValue) * 100;
    bar.style.width = `${percent}%`;

    barContainer.appendChild(bar);

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    item.appendChild(name);
    item.appendChild(barContainer);
    item.appendChild(value);

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
      <td>${item.created_at}</td>
    `;
    tbody.appendChild(row);
  });
}

function setupResizeHandler(data) {
  const container = document.getElementById('timeseries-container');
  
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (data.timeseries) {
        drawTimeSeriesChart(data.timeseries);
      }
    }, 100);
  });

  resizeObserver.observe(container);
}

async function init() {
  hideError();

  try {
    const data = await fetchData();

    // Apply persisted theme
    if (data.settings && data.settings.theme) {
      applyTheme(data.settings.theme);
    }

    // Render all sections
    renderStats(data.summary);
    renderCategories(data.categories);
    renderRecentTable(data.recent);

    // Draw chart initially
    drawTimeSeriesChart(data.timeseries);

    // Setup resize handling for chart
    setupResizeHandler(data);

    // Theme toggle
    const toggleBtn = document.getElementById('theme-toggle');
    toggleBtn.addEventListener('click', toggleTheme);

    // Re-draw chart on window resize as fallback
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        drawTimeSeriesChart(data.timeseries);
      }, 150);
    });

  } catch (err) {
    console.error(err);
  }
}

init();