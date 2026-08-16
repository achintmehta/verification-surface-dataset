const API_BASE = '/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSettings() {
  try {
    const settings = await fetchJSON(`${API_BASE}/settings`);
    currentTheme = settings.theme || 'light';
  } catch (e) {
    currentTheme = 'light';
  }
  applyTheme();
}

async function saveSettings(theme) {
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to save settings', e);
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', currentTheme);
}

function toggleTheme() {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme();
  saveSettings(currentTheme);
  // Redraw chart with new theme colors
  if (window.lastChartData) {
    renderTimeSeriesChart(window.lastChartData);
  }
}

async function fetchAllData() {
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`)
    ]);
    return { summary, timeseries, categories, recent };
  } catch (error) {
    throw error;
  }
}

function renderStats(summary) {
  const container = document.getElementById('stats-grid');
  container.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total Visitors</div>
      <div class="stat-value">${summary.totalVisitors.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value">$${summary.totalRevenue.toLocaleString()}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Best Day</div>
      <div class="stat-value">${summary.bestDay}</div>
      <div class="stat-trend">${summary.bestDayValue ? '$' + summary.bestDayValue.toLocaleString() : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">7-Day Trend</div>
      <div class="stat-value">${summary.trend7d >= 0 ? '+' : ''}${summary.trend7d}%</div>
      <div class="stat-trend">${summary.trend7d >= 0 ? '↑ Up' : '↓ Down'}</div>
    </div>
  `;
}

function renderTimeSeriesChart(data) {
  window.lastChartData = data;
  const container = document.getElementById('chart-container');
  container.innerHTML = '';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const width = container.clientWidth || 600;
  const height = 300;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const values = data.map(d => d.visitors);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(...values, 0);
  const range = maxVal - minVal || 1;

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

  // X axis labels (every ~5 days)
  const xStep = Math.ceil(data.length / 6);
  data.forEach((d, i) => {
    if (i % xStep === 0 || i === data.length - 1) {
      const x = padding.left + (chartWidth * i / (data.length - 1));
      
      // Tick
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', x);
      tick.setAttribute('y1', height - padding.bottom);
      tick.setAttribute('x2', x);
      tick.setAttribute('y2', height - padding.bottom + 5);
      tick.setAttribute('stroke', 'var(--chart-axis)');
      tick.setAttribute('stroke-width', '1');
      svg.appendChild(tick);

      // Label
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x);
      text.setAttribute('y', height - padding.bottom + 20);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'var(--chart-axis)');
      text.setAttribute('font-size', '10');
      const date = new Date(d.date);
      text.textContent = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      svg.appendChild(text);
    }
  });

  // X axis line
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', padding.left);
  xAxis.setAttribute('y1', height - padding.bottom);
  xAxis.setAttribute('x2', width - padding.right);
  xAxis.setAttribute('y2', height - padding.bottom);
  xAxis.setAttribute('stroke', 'var(--chart-axis)');
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  // Y axis line
  const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  yAxis.setAttribute('x1', padding.left);
  yAxis.setAttribute('y1', padding.top);
  yAxis.setAttribute('x2', padding.left);
  yAxis.setAttribute('y2', height - padding.bottom);
  yAxis.setAttribute('stroke', 'var(--chart-axis)');
  yAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(yAxis);

  // Line path
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

  container.appendChild(svg);
}

function renderCategories(categories) {
  const container = document.getElementById('category-list');
  const maxValue = Math.max(...categories.map(c => c.value), 1);

  container.innerHTML = '';
  categories.forEach(cat => {
    const pct = (cat.value / maxValue) * 100;
    const item = document.createElement('div');
    item.className = 'category-item';
    item.innerHTML = `
      <div class="category-name" title="${cat.name}">${cat.name}</div>
      <div class="category-bar-container">
        <div class="category-bar" style="width: ${pct}%"></div>
      </div>
      <div class="category-value">$${cat.value.toLocaleString()}</div>
    `;
    container.appendChild(item);
  });
}

function renderRecentTable(items) {
  const container = document.getElementById('recent-table');
  let html = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th>Value</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
  `;
  items.forEach(item => {
    const date = new Date(item.created_at).toLocaleDateString();
    html += `
      <tr>
        <td>${item.name}</td>
        <td>${item.category}</td>
        <td>$${item.value.toLocaleString()}</td>
        <td>${date}</td>
      </tr>
    `;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderDashboard(data) {
  renderStats(data.summary);
  renderTimeSeriesChart(data.timeseries);
  renderCategories(data.categories);
  renderRecentTable(data.recent);
}

function setupResizeHandler() {
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (window.lastChartData) {
        renderTimeSeriesChart(window.lastChartData);
      }
    }, 150);
  });
}

function showError() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="container">
      <div class="header">
        <h1>Metrics Dashboard</h1>
      </div>
      <div class="error-state">
        <h2>Unable to load data</h2>
        <p>Please ensure the backend server is running and try again.</p>
      </div>
    </div>
  `;
}

async function init() {
  const app = document.getElementById('app');
  
  app.innerHTML = `
    <div class="container">
      <div class="header">
        <h1>Metrics Dashboard</h1>
        <button id="theme-toggle" class="theme-toggle">
          <span id="theme-icon">🌓</span> Toggle Theme
        </button>
      </div>
      
      <div id="stats-grid" class="stats-grid"></div>
      
      <div class="dashboard-grid">
        <div class="chart-card">
          <div class="card-title">Visitors (30 Days)</div>
          <div id="chart-container" class="chart-container"></div>
        </div>
        
        <div class="category-card">
          <div class="card-title">Category Breakdown</div>
          <div id="category-list" class="category-list"></div>
        </div>
        
        <div class="table-card" style="grid-column: 1 / -1;">
          <div class="card-title">Recent Items</div>
          <div id="recent-table" class="table-container"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  try {
    await loadSettings();
    const data = await fetchAllData();
    renderDashboard(data);
    setupResizeHandler();
  } catch (error) {
    console.error('Failed to load dashboard:', error);
    showError();
  }
}

init();