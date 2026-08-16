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
  } catch (error) {
    console.error('Fetch error:', error);
    throw error;
  }
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
  } catch (e) {
    console.error('Failed to persist theme', e);
  }
}

function renderSummary(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
  document.getElementById('best-day').textContent = summary.bestDay;
  document.getElementById('best-revenue').textContent = '$' + summary.bestRevenue.toLocaleString();
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? '#22c55e' : '#ef4444';
}

function drawTimeseriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

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

  if (data.length === 0) return;

  const visitors = data.map(d => d.visitors);
  const minVal = Math.min(...visitors);
  const maxVal = Math.max(...visitors);
  const range = maxVal - minVal || 1;

  // Gridlines and axes
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  svg.appendChild(defs);

  // Background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', margin.left);
  bg.setAttribute('y', margin.top);
  bg.setAttribute('width', chartWidth);
  bg.setAttribute('height', chartHeight);
  bg.setAttribute('fill', 'none');
  svg.appendChild(bg);

  // Horizontal gridlines
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim() || '#e2e8f0';
  const axisColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#64748b';

  for (let i = 0; i <= 5; i++) {
    const y = margin.top + (chartHeight * i / 5);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', margin.left + chartWidth);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', gridColor);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y-axis labels
    const val = Math.round(maxVal - (range * i / 5));
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', margin.left - 10);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', axisColor);
    label.setAttribute('font-size', '11');
    label.textContent = val.toLocaleString();
    svg.appendChild(label);
  }

  // X-axis labels (every 5 days)
  const dates = data.map(d => d.date);
  for (let i = 0; i < dates.length; i += 5) {
    const x = margin.left + (chartWidth * i / (dates.length - 1));
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', margin.top + chartHeight);
    line.setAttribute('x2', x);
    line.setAttribute('y2', margin.top + chartHeight + 5);
    line.setAttribute('stroke', axisColor);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', margin.top + chartHeight + 20);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', axisColor);
    label.setAttribute('font-size', '10');
    label.textContent = dates[i].slice(5); // MM-DD
    svg.appendChild(label);
  }

  // Draw the line
  const lineColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || '#3b82f6';
  let pathD = '';
  data.forEach((d, i) => {
    const x = margin.left + (chartWidth * i / (data.length - 1));
    const y = margin.top + chartHeight - (chartHeight * (d.visitors - minVal) / range);
    pathD += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD.trim());
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', lineColor);
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Dots
  data.forEach((d, i) => {
    const x = margin.left + (chartWidth * i / (data.length - 1));
    const y = margin.top + chartHeight - (chartHeight * (d.visitors - minVal) / range);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', lineColor);
    svg.appendChild(circle);
  });
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';

  if (!categories.length) return;

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-bar';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // for tooltip if truncated

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const fill = document.createElement('div');
    fill.className = 'category-bar-fill';
    const percent = (cat.value / maxValue) * 100;
    fill.style.width = percent + '%';

    barContainer.appendChild(fill);

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    row.appendChild(name);
    row.appendChild(barContainer);
    row.appendChild(value);

    container.appendChild(row);
  });
}

function renderRecent(recent) {
  const tbody = document.getElementById('recent-table-body');
  tbody.innerHTML = '';

  recent.forEach(item => {
    const row = document.createElement('tr');
    const date = new Date(item.created_at).toISOString().split('T')[0];
    
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${parseFloat(item.value).toLocaleString()}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(row);
  });
}

function setupResizeHandler(timeseriesData) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (timeseriesData) {
        drawTimeseriesChart(timeseriesData);
      }
    }, 150);
  });
}

async function init() {
  const errorState = document.getElementById('error-state');
  const dashboard = document.getElementById('dashboard');

  try {
    const data = await fetchData();

    // Apply persisted theme before paint
    applyTheme(data.settings.theme || 'light');

    // Render all
    renderSummary(data.summary);
    renderCategories(data.categories);
    renderRecent(data.recent);
    drawTimeseriesChart(data.timeseries);

    // Setup interactions
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // Setup chart resize
    setupResizeHandler(data.timeseries);

    // Show dashboard
    dashboard.classList.remove('hidden');
    errorState.classList.add('hidden');

  } catch (error) {
    errorState.classList.remove('hidden');
    dashboard.classList.add('hidden');
  }
}

// Boot
init();