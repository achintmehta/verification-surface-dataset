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
    showErrorState();
    throw error;
  }
}

function showErrorState() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div style="text-align: center; padding: 60px 20px; color: var(--text-muted);">
      <h2>Unable to load dashboard</h2>
      <p>Backend server is not available. Please ensure the server is running.</p>
      <button onclick="location.reload()" style="margin-top: 16px; padding: 8px 16px;">Retry</button>
    </div>
  `;
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

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 10000) {
    return Math.round(num / 1000) + 'k';
  }
  return num.toLocaleString();
}

function formatCurrency(num) {
  return '$' + num.toLocaleString();
}

function renderSummary(summary) {
  document.getElementById('total-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('total-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('best-day').textContent = formatCurrency(summary.bestDay);
  
  const trendEl = document.getElementById('trend-value');
  const indicator = document.getElementById('trend-indicator');
  
  const trendText = (summary.trend >= 0 ? '+' : '') + summary.trend + '%';
  trendEl.textContent = trendText;
  
  if (summary.trend >= 0) {
    indicator.textContent = '↑';
    indicator.style.color = 'var(--success)';
  } else {
    indicator.textContent = '↓';
    indicator.style.color = '#ef4444';
  }
}

function renderChart(timeseries) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

  // Clear previous content
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  const padding = { top: 20, right: 30, bottom: 40, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  if (timeseries.length === 0) return;

  const maxVisitors = Math.max(...timeseries.map(d => d.visitors));
  const minVisitors = Math.min(...timeseries.map(d => d.visitors));
  const yRange = maxVisitors - minVisitors || 1;

  // Gridlines and Y axis
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
    text.setAttribute('x', padding.left - 8);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', 'var(--chart-axis)');
    text.setAttribute('font-size', '11');
    text.textContent = formatNumber(value);
    svg.appendChild(text);
  }

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

  // Data points and line
  const points = timeseries.map((d, i) => {
    const x = padding.left + (chartWidth * i / (timeseries.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    return { x, y, ...d };
  });

  // Draw line
  let pathD = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    pathD += ` L ${points[i].x} ${points[i].y}`;
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--chart-line)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // X ticks - show every ~5 days
  const xTickInterval = Math.ceil(timeseries.length / 6);
  timeseries.forEach((d, i) => {
    if (i % xTickInterval === 0 || i === timeseries.length - 1) {
      const x = points[i].x;
      
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
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', height - padding.bottom + 20);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', 'var(--chart-axis)');
      label.setAttribute('font-size', '10');
      const date = new Date(d.date);
      label.textContent = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      svg.appendChild(label);
    }
  });

  // Store data for resize
  svg.dataset.timeseries = JSON.stringify(timeseries);
}

function renderCategories(categories) {
  const container = document.getElementById('category-list');
  container.innerHTML = '';

  if (!categories.length) return;

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const pct = (cat.value / maxValue) * 100;

    item.innerHTML = `
      <div class="category-name" title="${cat.name}">${cat.name}</div>
      <div class="category-bar-container">
        <div class="category-bar" style="width: ${pct}%"></div>
      </div>
      <div class="category-value">${formatCurrency(cat.value)}</div>
    `;

    container.appendChild(item);
  });
}

function renderTable(recent) {
  const tbody = document.getElementById('recent-table');
  tbody.innerHTML = '';

  recent.forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>${formatCurrency(item.value)}</td>
      <td>${item.created_at}</td>
    `;
    tbody.appendChild(row);
  });
}

function setupResizeHandler() {
  const svg = document.getElementById('timeseries-chart');
  
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (svg && svg.dataset.timeseries) {
        const timeseries = JSON.parse(svg.dataset.timeseries);
        renderChart(timeseries);
      }
    }, 150);
  });
}

async function init() {
  try {
    const data = await fetchData();

    // Apply persisted theme
    applyTheme(data.settings.theme || 'light');

    // Render all sections
    renderSummary(data.summary);
    renderChart(data.timeseries);
    renderCategories(data.categories);
    renderTable(data.recent);

    // Theme toggle
    const toggleBtn = document.getElementById('theme-toggle');
    toggleBtn.addEventListener('click', toggleTheme);

    // Setup responsive chart redraw
    setupResizeHandler();

    // Initial chart fit check
    setTimeout(() => {
      const svg = document.getElementById('timeseries-chart');
      if (svg && svg.dataset.timeseries) {
        const timeseries = JSON.parse(svg.dataset.timeseries);
        renderChart(timeseries);
      }
    }, 100);

  } catch (error) {
    console.error('Initialization failed:', error);
  }
}

// Boot
init();