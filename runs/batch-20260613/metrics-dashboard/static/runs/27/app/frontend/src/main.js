const API_BASE = '/api';

let currentTheme = 'light';

async function fetchSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error('Failed to fetch settings');
    const data = await res.json();
    return data.theme || 'light';
  } catch (e) {
    console.error(e);
    return 'light';
  }
}

async function saveTheme(theme) {
  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    if (!res.ok) throw new Error('Failed to save theme');
    return await res.json();
  } catch (e) {
    console.error(e);
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

async function fetchJSON(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 10000) return Math.floor(n / 1000) + 'k';
  return n.toLocaleString();
}

function formatCurrency(n) {
  return '$' + n.toLocaleString();
}

function renderStats(summary) {
  const container = document.getElementById('stats-grid');
  container.innerHTML = `
    <div class="stat-card">
      <p class="stat-label">Total Visitors</p>
      <p class="stat-value">${summary.totalVisitors.toLocaleString()}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Total Revenue</p>
      <p class="stat-value">${formatCurrency(summary.totalRevenue)}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Best Day</p>
      <p class="stat-value">${summary.bestDay || 'N/A'}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">7-Day Trend</p>
      <p class="stat-value">${summary.sevenDayTrend >= 0 ? '+' : ''}${summary.sevenDayTrend}%</p>
      <p class="trend">vs previous week</p>
    </div>
  `;
}

function drawTimeSeriesChart(data) {
  const container = document.getElementById('chart-container');
  container.innerHTML = '';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 300');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const width = 800;
  const height = 300;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', width);
  bg.setAttribute('height', height);
  bg.setAttribute('fill', 'var(--card-bg)');
  svg.appendChild(bg);

  if (!data || data.length === 0) {
    container.appendChild(svg);
    return;
  }

  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const yRange = maxVisitors - minVisitors || 1;

  // Gridlines and Y labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartHeight * i / yTicks);
    const value = Math.round(maxVisitors - (yRange * i / yTicks));

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
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '12');
    text.textContent = value.toLocaleString();
    svg.appendChild(text);
  }

  // X labels (every 5 days)
  const xStep = Math.floor(data.length / 6) || 1;
  for (let i = 0; i < data.length; i += xStep) {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - 12);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '11');
    text.textContent = data[i].date.slice(5); // MM-DD
    svg.appendChild(text);

    // Vertical grid
    const vline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vline.setAttribute('x1', x);
    vline.setAttribute('y1', padding.top);
    vline.setAttribute('x2', x);
    vline.setAttribute('y2', height - padding.bottom);
    vline.setAttribute('stroke', 'var(--chart-grid)');
    vline.setAttribute('stroke-width', '0.5');
    svg.appendChild(vline);
  }

  // Line path
  let pathD = '';
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
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
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });

  // Axes
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', padding.left);
  xAxis.setAttribute('y1', height - padding.bottom);
  xAxis.setAttribute('x2', width - padding.right);
  xAxis.setAttribute('y2', height - padding.bottom);
  xAxis.setAttribute('stroke', 'var(--text-muted)');
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  yAxis.setAttribute('x1', padding.left);
  yAxis.setAttribute('y1', padding.top);
  yAxis.setAttribute('x2', padding.left);
  yAxis.setAttribute('y2', height - padding.bottom);
  yAxis.setAttribute('stroke', 'var(--text-muted)');
  yAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(yAxis);

  container.appendChild(svg);

  // Resize handler
  const resizeObserver = new ResizeObserver(() => {
    // Re-render on resize to adapt
    if (container.firstChild) {
      drawTimeSeriesChart(data);
    }
  });
  resizeObserver.observe(container);
}

function renderCategories(cats) {
  const container = document.getElementById('category-list');
  container.innerHTML = '';

  const maxVal = Math.max(...cats.map(c => c.value));

  cats.forEach(cat => {
    const pct = (cat.value / maxVal) * 100;
    const item = document.createElement('div');
    item.className = 'category-item';
    item.innerHTML = `
      <div class="category-name" title="${cat.name}">${cat.name}</div>
      <div class="category-bar-container">
        <div class="category-bar" style="width: ${pct}%"></div>
      </div>
      <div class="category-value">${formatNumber(cat.value)}</div>
    `;
    container.appendChild(item);
  });
}

function renderRecent(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const date = new Date(item.created_at).toLocaleDateString();
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>${formatCurrency(item.value)}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(row);
  });
}

async function loadDashboard() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <header>
      <h1>Metrics Dashboard</h1>
      <button id="theme-toggle" class="theme-toggle">Toggle Theme</button>
    </header>
    <div class="dashboard">
      <div id="stats-grid" class="stats-grid"></div>
      
      <div class="main-grid">
        <div class="chart-card">
          <h2 class="card-title">30-Day Visitors Trend</h2>
          <div id="chart-container" class="chart-container"></div>
        </div>
        
        <div class="category-card">
          <h2 class="card-title">Category Breakdown</h2>
          <div id="category-list" class="category-list"></div>
        </div>
        
        <div class="table-card" style="grid-column: 1 / -1;">
          <h2 class="card-title">Recent Items</h2>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Value</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody id="recent-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  // Theme toggle
  const toggleBtn = document.getElementById('theme-toggle');
  toggleBtn.textContent = currentTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
  toggleBtn.addEventListener('click', async () => {
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
    toggleBtn.textContent = newTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
    await saveTheme(newTheme);
  });

  try {
    // Load all data
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent')
    ]);

    renderStats(summary);
    drawTimeSeriesChart(timeseries);
    renderCategories(categories);
    renderRecent(recent);
  } catch (error) {
    console.error('Failed to load dashboard data:', error);
    const main = document.querySelector('.dashboard');
    main.innerHTML = `
      <div class="error-state">
        <h2>Unable to load dashboard</h2>
        <p>Could not connect to the metrics API. Please ensure the backend server is running.</p>
        <button onclick="location.reload()">Retry</button>
      </div>
    `;
  }
}

async function init() {
  // Fetch and apply theme before rendering to avoid flash
  const theme = await fetchSettings();
  applyTheme(theme);

  await loadDashboard();
}

init();