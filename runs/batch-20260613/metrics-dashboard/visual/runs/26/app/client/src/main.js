const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSettings() {
  try {
    const { theme } = await fetchJSON(`${API_BASE}/settings`);
    currentTheme = theme;
    applyTheme(theme);
  } catch (e) {
    console.error('Failed to load settings', e);
    applyTheme('light');
  }
}

async function saveTheme(theme) {
  try {
    await fetchJSON(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    currentTheme = theme;
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  currentTheme = theme;
}

function createApp() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="dashboard">
      <header class="header">
        <h1>Metrics Dashboard</h1>
        <div class="header-actions">
          <button id="theme-toggle" class="theme-toggle" aria-label="Toggle theme">
            <span class="toggle-icon">🌓</span>
          </button>
        </div>
      </header>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Visitors</div>
          <div id="total-visitors" class="stat-value">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Revenue</div>
          <div id="total-revenue" class="stat-value">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Best Day</div>
          <div id="best-day" class="stat-value">--</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">7-Day Trend</div>
          <div id="seven-day-trend" class="stat-value">--</div>
        </div>
      </div>

      <div class="main-grid">
        <div class="chart-card">
          <h2>30-Day Visitors Trend</h2>
          <div id="timeseries-container" class="chart-container">
            <svg id="timeseries-chart" width="100%" height="300"></svg>
          </div>
        </div>

        <div class="breakdown-card">
          <h2>Category Breakdown</h2>
          <div id="categories-container" class="categories"></div>
        </div>
      </div>

      <div class="table-card">
        <h2>Recent Items</h2>
        <div class="table-container">
          <table id="recent-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Value</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <div id="error-banner" class="error-banner" style="display: none;">
        Unable to connect to the metrics server. Please ensure the backend is running.
      </div>
    </div>
  `;

  setupThemeToggle();
  loadDashboardData();
  setupResizeHandler();
}

function setupThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
    // Redraw chart with new theme colors
    await redrawChart();
  });
}

let chartData = null;

async function loadDashboardData() {
  const errorBanner = document.getElementById('error-banner');
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`)
    ]);

    // Render summary
    document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
    document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
    document.getElementById('best-day').textContent = summary.bestDay;
    const trendEl = document.getElementById('seven-day-trend');
    trendEl.textContent = (summary.sevenDayTrend >= 0 ? '+' : '') + summary.sevenDayTrend + '%';
    trendEl.className = 'stat-value ' + (summary.sevenDayTrend >= 0 ? 'trend-up' : 'trend-down');

    // Store for chart
    chartData = timeseries;
    renderTimeseriesChart(timeseries);

    // Categories
    renderCategories(categories);

    // Recent items
    renderRecentTable(recent);

    errorBanner.style.display = 'none';
  } catch (err) {
    console.error('Failed to load dashboard data', err);
    errorBanner.style.display = 'block';
    // Show empty states
    document.getElementById('total-visitors').textContent = 'N/A';
    document.getElementById('total-revenue').textContent = 'N/A';
    document.getElementById('best-day').textContent = 'N/A';
    document.getElementById('seven-day-trend').textContent = 'N/A';
  }
}

function renderTimeseriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg || !data || data.length === 0) return;

  const container = document.getElementById('timeseries-container');
  const width = container.clientWidth || 600;
  const height = 300;
  const padding = { top: 20, right: 30, bottom: 50, left: 60 };

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const yRange = maxVisitors - minVisitors || 1;

  const points = data.map((d, i) => {
    const x = padding.left + (i / (data.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - ((d.visitors - minVisitors) / yRange) * chartHeight;
    return { x, y, ...d };
  });

  const isDark = currentTheme === 'dark';
  const axisColor = isDark ? '#64748b' : '#94a3b8';
  const gridColor = isDark ? '#334155' : '#e2e8f0';
  const lineColor = isDark ? '#60a5fa' : '#3b82f6';
  const textColor = isDark ? '#e2e8f0' : '#1e293b';

  let svgContent = `
    <rect width="${width}" height="${height}" fill="transparent"/>
  `;

  // Grid lines (horizontal)
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (i / yTicks) * chartHeight;
    const val = Math.round(maxVisitors - (i / yTicks) * yRange);
    svgContent += `
      <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="${gridColor}" stroke-width="1"/>
      <text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" fill="${axisColor}" font-size="11">${val.toLocaleString()}</text>
    `;
  }

  // X axis labels (every 5 days)
  data.forEach((d, i) => {
    if (i % 5 === 0 || i === data.length - 1) {
      const x = padding.left + (i / (data.length - 1)) * chartWidth;
      const dateLabel = d.date.slice(5); // MM-DD
      svgContent += `
        <line x1="${x}" y1="${padding.top + chartHeight}" x2="${x}" y2="${padding.top + chartHeight + 5}" stroke="${axisColor}" stroke-width="1"/>
        <text x="${x}" y="${padding.top + chartHeight + 20}" text-anchor="middle" fill="${axisColor}" font-size="10">${dateLabel}</text>
      `;
    }
  });

  // Axes
  svgContent += `
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="${axisColor}" stroke-width="1.5"/>
    <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="${axisColor}" stroke-width="1.5"/>
  `;

  // Line path
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  svgContent += `
    <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  `;

  // Dots
  points.forEach(p => {
    svgContent += `
      <circle cx="${p.x}" cy="${p.y}" r="3" fill="${lineColor}"/>
    `;
  });

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = svgContent;
}

async function redrawChart() {
  if (chartData) {
    renderTimeseriesChart(chartData);
  }
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const pct = (cat.value / maxValue) * 100;
    const isDark = currentTheme === 'dark';
    const barColor = isDark ? '#60a5fa' : '#3b82f6';
    const labelColor = isDark ? '#e2e8f0' : '#1e293b';

    const div = document.createElement('div');
    div.className = 'category-row';
    div.innerHTML = `
      <div class="category-name" title="${cat.name}">${cat.name}</div>
      <div class="category-bar-container">
        <div class="category-bar" style="width: ${pct}%; background: ${barColor};"></div>
      </div>
      <div class="category-value" style="color: ${labelColor};">${cat.value.toLocaleString()}</div>
    `;
    container.appendChild(div);
  });
}

function renderRecentTable(items) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const row = document.createElement('tr');
    const date = item.created_at.split(' ')[0];
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${parseFloat(item.value).toLocaleString()}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(row);
  });
}

function setupResizeHandler() {
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      redrawChart();
    }, 150);
  });
}

// Initialize
async function init() {
  await loadSettings();
  createApp();
}

init();