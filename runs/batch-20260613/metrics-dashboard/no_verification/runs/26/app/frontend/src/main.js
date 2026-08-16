const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';
let resizeObserver = null;

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  try {
    const [summary, timeseries, categories, recent, settings] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`),
      fetchJSON(`${API_BASE}/settings`)
    ]);

    // Apply persisted theme
    applyTheme(settings.theme || 'light');

    // Render all sections
    renderStats(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderRecentTable(recent);

    // Setup resize handler for chart
    setupChartResize(timeseries);

    hideError();
  } catch (err) {
    console.error('Failed to load data:', err);
    showError('Unable to load dashboard data. Please ensure the backend server is running.');
    // Show empty state
    showEmptyState();
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

function showEmptyState() {
  document.getElementById('total-visitors').textContent = '—';
  document.getElementById('total-revenue').textContent = '—';
  document.getElementById('best-day').textContent = '—';
  document.getElementById('trend-value').textContent = '—';
  document.getElementById('category-bars').innerHTML = '<p style="color: var(--text-muted)">No data available</p>';
  document.getElementById('recent-table-body').innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No data</td></tr>';
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  
  const revenueEl = document.getElementById('total-revenue');
  revenueEl.textContent = '$' + summary.totalRevenue.toLocaleString();
  
  document.getElementById('best-day').textContent = summary.bestDay || '—';

  const trendValue = document.getElementById('trend-value');
  const indicator = document.getElementById('trend-indicator');
  
  const trend = summary.trend7Day || 0;
  trendValue.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  
  indicator.textContent = trend >= 0 ? '↑' : '↓';
  indicator.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

function renderChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!data || data.length === 0) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--text-muted)">No data</text>';
    return;
  }

  // Clear previous
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  const margin = { top: 20, right: 30, bottom: 50, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const visitors = data.map(d => d.visitors);
  const maxVisitors = Math.max(...visitors);
  const minVisitors = Math.min(...visitors);
  const yRange = maxVisitors - minVisitors || 1;

  // Grid lines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = margin.top + (chartHeight * i / yTicks);
    const value = Math.round(maxVisitors - (yRange * i / yTicks));

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

  // X axis line
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', margin.left);
  xAxis.setAttribute('y1', height - margin.bottom);
  xAxis.setAttribute('x2', width - margin.right);
  xAxis.setAttribute('y2', height - margin.bottom);
  xAxis.setAttribute('stroke', 'var(--chart-axis)');
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  // Y axis line
  const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  yAxis.setAttribute('x1', margin.left);
  yAxis.setAttribute('y1', margin.top);
  yAxis.setAttribute('x2', margin.left);
  yAxis.setAttribute('y2', height - margin.bottom);
  yAxis.setAttribute('stroke', 'var(--chart-axis)');
  yAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(yAxis);

  // Data points and line
  const points = data.map((d, i) => {
    const x = margin.left + (chartWidth * i / (data.length - 1));
    const y = margin.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    return { x, y, ...d };
  });

  // Draw line
  let pathD = '';
  points.forEach((p, i) => {
    pathD += (i === 0 ? 'M' : 'L') + `${p.x},${p.y} `;
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD.trim());
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--chart-line)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Draw points
  points.forEach(p => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x);
    circle.setAttribute('cy', p.y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });

  // X axis labels (every ~5 days)
  const labelInterval = Math.ceil(data.length / 6);
  data.forEach((d, i) => {
    if (i % labelInterval === 0 || i === data.length - 1) {
      const x = margin.left + (chartWidth * i / (data.length - 1));
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x);
      text.setAttribute('y', height - margin.bottom + 20);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'var(--chart-axis)');
      text.setAttribute('font-size', '10');
      text.textContent = d.date.slice(5); // MM-DD
      svg.appendChild(text);

      // Tick
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', x);
      tick.setAttribute('y1', height - margin.bottom);
      tick.setAttribute('x2', x);
      tick.setAttribute('y2', height - margin.bottom + 5);
      tick.setAttribute('stroke', 'var(--chart-axis)');
      tick.setAttribute('stroke-width', '1');
      svg.appendChild(tick);
    }
  });
}

function setupChartResize(timeseriesData) {
  const container = document.getElementById('chart-container');
  
  // Remove previous observer
  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  resizeObserver = new ResizeObserver(() => {
    const svg = document.getElementById('timeseries-chart');
    if (svg && timeseriesData) {
      renderChart(timeseriesData);
    }
  });

  resizeObserver.observe(container);
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';

  if (!categories || categories.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted)">No categories</p>';
    return;
  }

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const header = document.createElement('div');
    header.className = 'category-header';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // full name on hover

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    header.appendChild(name);
    header.appendChild(value);

    const barContainer = document.createElement('div');
    barContainer.className = 'bar-container';

    const bar = document.createElement('div');
    bar.className = 'bar';
    const percent = maxValue > 0 ? (cat.value / maxValue) * 100 : 0;
    bar.style.width = percent + '%';

    barContainer.appendChild(bar);

    item.appendChild(header);
    item.appendChild(barContainer);
    container.appendChild(item);
  });
}

function renderRecentTable(items) {
  const tbody = document.getElementById('recent-table-body');
  tbody.innerHTML = '';

  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No recent items</td></tr>';
    return;
  }

  items.forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${item.created_at}</td>
    `;
    tbody.appendChild(row);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  
  // Update toggle button text/icon
  const toggle = document.getElementById('theme-toggle');
  toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
    
    applyTheme(newTheme);
    
    // Re-render chart to update colors
    const svg = document.getElementById('timeseries-chart');
    if (svg && svg.dataset.data) {
      // We store data on svg for re-render
    }
  } catch (err) {
    console.error('Failed to save theme:', err);
    // Apply locally anyway
    applyTheme(newTheme);
  }
}

function setupThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', toggleTheme);
}

function init() {
  setupThemeToggle();
  loadData();
  
  // Keyboard support for theme
  document.addEventListener('keydown', (e) => {
    if (e.key === 't' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggleTheme();
    }
  });
}

init();