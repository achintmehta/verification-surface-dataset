const API_BASE = '/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchData(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`Failed to fetch ${endpoint}`);
  return res.json();
}

async function fetchSettings() {
  try {
    const data = await fetchData('/settings');
    return data.theme || 'light';
  } catch (e) {
    return 'light';
  }
}

async function updateSettings(theme) {
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to persist theme', e);
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  currentTheme = theme;
}

async function initTheme() {
  const savedTheme = await fetchSettings();
  applyTheme(savedTheme);
}

function createStatCard(label, value, trend = null) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  
  let trendHtml = '';
  if (trend !== null) {
    const trendClass = trend >= 0 ? 'trend-up' : '';
    const trendIcon = trend >= 0 ? '↑' : '↓';
    trendHtml = `<div class="stat-trend ${trendClass}">${trendIcon} ${Math.abs(trend)}% from last week</div>`;
  }
  
  card.innerHTML = `
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    ${trendHtml}
  `;
  return card;
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 10000) {
    return Math.floor(num / 1000) + 'k';
  }
  return num.toLocaleString();
}

function formatCurrency(num) {
  return '$' + num.toLocaleString();
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function renderDashboard() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <header>
      <h1>Metrics Dashboard</h1>
      <button class="theme-toggle" id="theme-toggle">
        <span id="theme-icon">🌙</span>
        <span id="theme-text">Dark Mode</span>
      </button>
    </header>
    <div id="content">
      <div class="stats-grid" id="stats-grid"></div>
      <div class="main-grid">
        <div class="chart-card">
          <div class="card-title">30-Day Visitors Trend</div>
          <div class="chart-container" id="chart-container"></div>
        </div>
        <div class="category-card">
          <div class="card-title">Category Breakdown</div>
          <div class="category-list" id="category-list"></div>
        </div>
        <div class="table-card" style="grid-column: 1 / -1;">
          <div class="card-title">Recent Items</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th style="text-align:right">Value</th>
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
  const themeIcon = document.getElementById('theme-icon');
  const themeText = document.getElementById('theme-text');
  
  function updateToggleUI() {
    if (currentTheme === 'dark') {
      themeIcon.textContent = '☀️';
      themeText.textContent = 'Light Mode';
    } else {
      themeIcon.textContent = '🌙';
      themeText.textContent = 'Dark Mode';
    }
  }
  
  updateToggleUI();
  
  toggleBtn.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    updateToggleUI();
    await updateSettings(newTheme);
    // Redraw chart with new theme colors
    await renderChart();
  });
  
  // Load data
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchData('/summary'),
      fetchData('/timeseries'),
      fetchData('/categories'),
      fetchData('/recent')
    ]);
    
    // Render stats
    renderStats(summary);
    
    // Render chart
    window.timeseriesData = timeseries;
    await renderChart();
    
    // Render categories
    renderCategories(categories);
    
    // Render recent
    renderRecent(recent);
    
    // Setup resize handler for chart
    setupResizeHandler();
    
  } catch (error) {
    console.error('Dashboard load error:', error);
    document.getElementById('content').innerHTML = `
      <div class="error-state">
        <h2>Unable to load dashboard</h2>
        <p>Please ensure the backend server is running and try again.</p>
      </div>
    `;
  }
}

function renderStats(summary) {
  const container = document.getElementById('stats-grid');
  container.innerHTML = '';
  
  // Total Visitors
  container.appendChild(createStatCard(
    'Total Visitors',
    summary.totalVisitors.toLocaleString()
  ));
  
  // Total Revenue
  container.appendChild(createStatCard(
    'Total Revenue',
    formatCurrency(Math.floor(summary.totalRevenue))
  ));
  
  // Best Day
  const bestDate = new Date(summary.bestDay.date).toLocaleDateString('en-US', { 
    month: 'short', day: 'numeric' 
  });
  container.appendChild(createStatCard(
    'Best Day',
    `${bestDate} — ${summary.bestDay.visitors.toLocaleString()} visitors`
  ));
  
  // 7-day trend
  const trendCard = createStatCard(
    '7-Day Trend',
    `${summary.sevenDayTrend >= 0 ? '+' : ''}${summary.sevenDayTrend}%`,
    summary.sevenDayTrend
  );
  container.appendChild(trendCard);
}

async function renderChart() {
  const container = document.getElementById('chart-container');
  if (!container || !window.timeseriesData) return;
  
  container.innerHTML = '';
  
  const data = window.timeseriesData;
  const width = container.clientWidth || 600;
  const height = 280;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  // Get theme colors
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--chart-line').trim() || '#3b82f6';
  const gridColor = style.getPropertyValue('--chart-grid').trim() || '#e2e8f0';
  const axisColor = style.getPropertyValue('--chart-axis').trim() || '#64748b';
  
  // Scales
  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const yRange = maxVisitors - minVisitors || 1;
  
  // Grid lines and Y axis labels
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
    line.setAttribute('stroke', gridColor);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    
    // Y label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', padding.left - 10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', axisColor);
    text.setAttribute('font-size', '11');
    text.textContent = value.toLocaleString();
    svg.appendChild(text);
  }
  
  // X axis labels (every 5 days)
  const xStep = Math.ceil(data.length / 6);
  for (let i = 0; i < data.length; i += xStep) {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const dateLabel = formatDate(data[i].date);
    
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - padding.bottom + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', axisColor);
    text.setAttribute('font-size', '11');
    text.textContent = dateLabel;
    svg.appendChild(text);
    
    // Tick
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('y1', height - padding.bottom);
    tick.setAttribute('x2', x);
    tick.setAttribute('y2', height - padding.bottom + 5);
    tick.setAttribute('stroke', axisColor);
    tick.setAttribute('stroke-width', '1');
    svg.appendChild(tick);
  }
  
  // Draw line
  let pathD = '';
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight * (1 - (d.visitors - minVisitors) / yRange);
    pathD += (i === 0 ? 'M' : 'L') + ` ${x} ${y}`;
  });
  
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', lineColor);
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  
  // Draw dots
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight * (1 - (d.visitors - minVisitors) / yRange);
    
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', lineColor);
    svg.appendChild(circle);
  });
  
  // Axes
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', padding.left);
  xAxis.setAttribute('y1', height - padding.bottom);
  xAxis.setAttribute('x2', width - padding.right);
  xAxis.setAttribute('y2', height - padding.bottom);
  xAxis.setAttribute('stroke', axisColor);
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);
  
  const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  yAxis.setAttribute('x1', padding.left);
  yAxis.setAttribute('y1', padding.top);
  yAxis.setAttribute('x2', padding.left);
  yAxis.setAttribute('y2', height - padding.bottom);
  yAxis.setAttribute('stroke', axisColor);
  yAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(yAxis);
  
  container.appendChild(svg);
}

function setupResizeHandler() {
  window.addEventListener('resize', () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      renderChart();
    }, 150);
  });
}

function renderCategories(categories) {
  const container = document.getElementById('category-list');
  container.innerHTML = '';
  
  const maxValue = Math.max(...categories.map(c => c.value));
  
  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';
    
    const percentage = (cat.value / maxValue) * 100;
    
    item.innerHTML = `
      <div class="category-name" title="${cat.name}">${cat.name}</div>
      <div class="category-bar-container">
        <div class="category-bar" style="width: ${percentage}%"></div>
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
    const row = document.createElement('tr');
    const date = new Date(item.created_at).toLocaleDateString('en-US', { 
      month: 'short', day: 'numeric' 
    });
    
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td class="value">$${item.value.toLocaleString()}</td>
      <td>${date}</td>
    `;
    
    tbody.appendChild(row);
  });
}

// Initialize
async function init() {
  await initTheme();
  await renderDashboard();
}

init();