const API_BASE = '/api';

let currentTheme = 'light';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSettings() {
  try {
    const { theme } = await fetchJSON(`${API_BASE}/settings`);
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    console.error('Failed to load settings', e);
    document.documentElement.setAttribute('data-theme', 'light');
  }
}

async function saveTheme(theme) {
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    renderChart(); // redraw chart with new theme
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function createStatCards(summary) {
  return `
    <div class="stats">
      <div class="card">
        <div class="stat-label">Total Visitors</div>
        <div class="stat-value">${summary.totalVisitors.toLocaleString()}</div>
      </div>
      <div class="card">
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value">$${parseFloat(summary.totalRevenue).toLocaleString()}</div>
      </div>
      <div class="card">
        <div class="stat-label">Best Day</div>
        <div class="stat-value">${new Date(summary.bestDay).toLocaleDateString()}</div>
        <div class="stat-label">${summary.bestDayVisitors.toLocaleString()} visitors</div>
      </div>
      <div class="card">
        <div class="stat-label">7-Day Trend</div>
        <div class="stat-value">${summary.sevenDayTrend > 0 ? '+' : ''}${summary.sevenDayTrend}%</div>
        <div class="trend">↑ vs previous 7 days</div>
      </div>
    </div>
  `;
}

function createCategoryBreakdown(categories) {
  const maxValue = Math.max(...categories.map(c => c.value));
  let html = '<div class="breakdown-container"><h2>Category Breakdown</h2>';
  categories.forEach(cat => {
    const pct = (cat.value / maxValue) * 100;
    html += `
      <div class="bar-row">
        <div class="bar-label" title="${cat.name}">${cat.name}</div>
        <div class="bar-container">
          <div class="bar" style="width: ${pct}%"></div>
        </div>
        <div class="bar-value">$${(cat.value / 1000000).toFixed(1)}M</div>
      </div>
    `;
  });
  html += '</div>';
  return html;
}

function createRecentTable(items) {
  let html = `
    <div class="table-container">
      <h2>Recent Items</h2>
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
        <td>$${parseFloat(item.value).toFixed(2)}</td>
        <td>${date}</td>
      </tr>
    `;
  });
  html += '</tbody></table></div>';
  return html;
}

let chartData = null;
let resizeHandler = null;

function drawChart(timeseries) {
  const container = document.getElementById('chart-container');
  if (!container) return;

  container.innerHTML = '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '300');
  svg.setAttribute('viewBox', '0 0 800 300');
  svg.style.display = 'block';

  const padding = { top: 20, right: 40, bottom: 40, left: 60 };
  const width = 800 - padding.left - padding.right;
  const height = 300 - padding.top - padding.bottom;

  const dates = timeseries.map(d => d.date);
  const visitors = timeseries.map(d => d.visitors);
  const maxV = Math.max(...visitors);
  const minV = Math.min(...visitors);

  // Gridlines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (height / yTicks) * i;
    const val = Math.round(maxV - (maxV - minV) / yTicks * i);

    // grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', padding.left + width);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', padding.left - 10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '12');
    text.textContent = val.toLocaleString();
    svg.appendChild(text);
  }

  // X axis labels - show every 5 days
  const xStep = Math.floor(dates.length / 6);
  dates.forEach((date, i) => {
    if (i % xStep !== 0 && i !== dates.length - 1) return;
    const x = padding.left + (i / (dates.length - 1)) * width;
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', padding.top + height + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '11');
    text.textContent = new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.appendChild(text);

    // tick
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('y1', padding.top + height);
    tick.setAttribute('x2', x);
    tick.setAttribute('y2', padding.top + height + 5);
    tick.setAttribute('stroke', 'var(--chart-grid)');
    svg.appendChild(tick);
  });

  // Line path
  let pathD = '';
  visitors.forEach((v, i) => {
    const x = padding.left + (i / (dates.length - 1)) * width;
    const y = padding.top + height - ((v - minV) / (maxV - minV || 1)) * height;
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
  visitors.forEach((v, i) => {
    const x = padding.left + (i / (dates.length - 1)) * width;
    const y = padding.top + height - ((v - minV) / (maxV - minV || 1)) * height;
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });

  container.appendChild(svg);
}

function renderChart() {
  if (chartData) {
    drawChart(chartData);
  }
}

function setupResizeListener() {
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  resizeHandler = () => {
    // debounce
    clearTimeout(window.chartResizeTimeout);
    window.chartResizeTimeout = setTimeout(() => {
      renderChart();
    }, 150);
  };
  window.addEventListener('resize', resizeHandler);
}

async function renderDashboard() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="container">
      <header>
        <h1>Metrics Dashboard</h1>
        <button id="theme-toggle" class="theme-toggle">Toggle Theme</button>
      </header>
      <div id="content"></div>
    </div>
  `;

  const content = document.getElementById('content');
  const toggle = document.getElementById('theme-toggle');

  toggle.addEventListener('click', () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    saveTheme(newTheme);
  });

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`)
    ]);

    chartData = timeseries;

    content.innerHTML = `
      ${createStatCards(summary)}
      <div class="grid">
        <div class="chart-container">
          <h2>30-Day Visitors Trend</h2>
          <div id="chart-container" class="chart"></div>
        </div>
        <div id="breakdown-slot"></div>
      </div>
      <div style="margin-top: 1.5rem;">
        ${createRecentTable(recent)}
      </div>
    `;

    // Insert breakdown
    const breakdownSlot = document.getElementById('breakdown-slot');
    breakdownSlot.innerHTML = createCategoryBreakdown(categories);

    // Draw chart
    drawChart(timeseries);
    setupResizeListener();

  } catch (error) {
    content.innerHTML = `
      <div class="error">
        <h2>Unable to load dashboard</h2>
        <p>Could not connect to the metrics server. Please ensure the backend is running.</p>
        <p><small>${error.message}</small></p>
      </div>
    `;
  }
}

async function init() {
  await loadSettings();
  await renderDashboard();
}

init();