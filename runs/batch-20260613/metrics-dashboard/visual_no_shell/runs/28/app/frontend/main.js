const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';

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
    console.error('Fetch error:', err);
    document.getElementById('error-banner').style.display = 'block';
    throw err;
  }
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
  document.getElementById('best-day').textContent = summary.bestDay;
  document.getElementById('best-day-visitors').textContent = summary.bestDayVisitors.toLocaleString() + ' visitors';
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

function drawTimeSeriesChart(timeseries) {
  const svg = document.getElementById('timeseries-chart');
  const container = document.getElementById('chart-container');
  
  // Clear previous
  svg.innerHTML = '';
  
  const width = container.clientWidth || 600;
  const height = 300;
  const margin = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const data = timeseries;
  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const padding = (maxVisitors - minVisitors) * 0.1 || 100;

  const yMin = Math.max(0, minVisitors - padding);
  const yMax = maxVisitors + padding;

  // Grid lines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = margin.top + (chartHeight / yTicks) * i;
    const value = Math.round(yMax - (yMax - yMin) / yTicks * i);

    // Grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - margin.right);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', margin.left - 10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', 'var(--chart-axis)');
    text.setAttribute('font-size', '11');
    text.textContent = value.toLocaleString();
    svg.appendChild(text);
  }

  // X axis labels (every 5 days)
  const xStep = Math.floor(data.length / 6);
  for (let i = 0; i < data.length; i += xStep) {
    const x = margin.left + (i / (data.length - 1)) * chartWidth;
    const date = data[i].date;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', margin.top);
    line.setAttribute('x2', x);
    line.setAttribute('y2', height - margin.bottom);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - margin.bottom + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', 'var(--chart-axis)');
    text.setAttribute('font-size', '10');
    text.textContent = date.slice(5); // MM-DD
    svg.appendChild(text);
  }

  // Draw the line
  let pathD = '';
  data.forEach((d, i) => {
    const x = margin.left + (i / (data.length - 1)) * chartWidth;
    const y = margin.top + chartHeight - ((d.visitors - yMin) / (yMax - yMin)) * chartHeight;
    pathD += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
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
    const x = margin.left + (i / (data.length - 1)) * chartWidth;
    const y = margin.top + chartHeight - ((d.visitors - yMin) / (yMax - yMin)) * chartHeight;
    
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });
}

function renderCategories(categories) {
  const container = document.getElementById('category-list');
  container.innerHTML = '';

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // for tooltip

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    const percent = (cat.value / maxValue) * 100;
    bar.style.width = percent + '%';

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    barContainer.appendChild(bar);
    item.appendChild(name);
    item.appendChild(barContainer);
    item.appendChild(value);
    container.appendChild(item);
  });
}

function renderRecentTable(recent) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  recent.forEach(item => {
    const row = document.createElement('tr');
    
    const date = new Date(item.created_at).toISOString().split('T')[0];

    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(row);
  });
}

async function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  
  // Re-draw chart if data exists to update colors
  const svg = document.getElementById('timeseries-chart');
  if (svg.children.length > 0 && window.lastTimeseries) {
    drawTimeSeriesChart(window.lastTimeseries);
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
    await applyTheme(newTheme);
  } catch (err) {
    console.error('Failed to save theme:', err);
    // Apply locally anyway
    await applyTheme(newTheme);
  }
}

function setupResizeHandler() {
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (window.lastTimeseries) {
        drawTimeSeriesChart(window.lastTimeseries);
      }
    }, 150);
  });
}

async function init() {
  const toggleBtn = document.getElementById('theme-toggle');
  toggleBtn.addEventListener('click', toggleTheme);

  setupResizeHandler();

  try {
    const data = await fetchData();
    
    // Apply persisted theme first
    if (data.settings && data.settings.theme) {
      await applyTheme(data.settings.theme);
    }

    // Render all
    renderStats(data.summary);
    window.lastTimeseries = data.timeseries;
    drawTimeSeriesChart(data.timeseries);
    renderCategories(data.categories);
    renderRecentTable(data.recent);

    // Initial chart draw after layout
    setTimeout(() => {
      if (window.lastTimeseries) {
        drawTimeSeriesChart(window.lastTimeseries);
      }
    }, 100);

  } catch (err) {
    // Error banner already shown
    console.log('Dashboard initialized with error state');
  }
}

init();