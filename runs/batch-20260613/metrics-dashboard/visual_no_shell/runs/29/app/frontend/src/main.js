const API_BASE = '/api';

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
  } catch (error) {
    console.error('Fetch error:', error);
    document.getElementById('error-banner').style.display = 'block';
    throw error;
  }
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
  document.getElementById('best-day').textContent = summary.bestDay || 'N/A';
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

function drawTimeSeriesChart(timeseries) {
  const svg = document.getElementById('timeseries-chart');
  const container = document.getElementById('timeseries-container');
  
  // Clear previous content
  svg.innerHTML = '';
  
  if (!timeseries || timeseries.length === 0) return;

  // Get container dimensions
  const rect = container.getBoundingClientRect();
  const width = Math.max(rect.width, 300);
  const height = 300;
  
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxVisitors = Math.max(...timeseries.map(d => d.visitors));
  const minVisitors = Math.min(...timeseries.map(d => d.visitors));
  const yRange = maxVisitors - minVisitors || 1;

  // Draw gridlines and y-axis labels
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
    text.setAttribute('fill', 'var(--chart-axis)');
    text.setAttribute('font-size', '11');
    text.textContent = value.toLocaleString();
    svg.appendChild(text);
  }

  // X-axis labels (every 5 days)
  const xStep = Math.floor(timeseries.length / 6) || 1;
  for (let i = 0; i < timeseries.length; i += xStep) {
    const x = padding.left + (chartWidth * i / (timeseries.length - 1));
    const date = timeseries[i].date;

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
  timeseries.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (timeseries.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    
    if (i === 0) {
      pathD = `M ${x} ${y}`;
    } else {
      pathD += ` L ${x} ${y}`;
    }
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--chart-line)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Draw points
  timeseries.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (timeseries.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    
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
    name.title = cat.name; // full name on hover

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    const percent = (cat.value / maxValue) * 100;
    bar.style.width = `${percent}%`;

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

  if (!recent || recent.length === 0) return;

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
  
  // Redraw chart with new theme colors
  const chart = document.getElementById('timeseries-chart');
  if (chart && chart.children.length > 0) {
    // Re-fetch and redraw? For simplicity, we'll trigger a resize which redraws
    window.dispatchEvent(new Event('resize'));
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
  } catch (e) {
    console.error('Failed to save theme:', e);
    // Apply locally anyway
    await applyTheme(newTheme);
  }
}

function setupResizeHandler(timeseriesData) {
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      const svg = document.getElementById('timeseries-chart');
      if (svg && timeseriesData) {
        drawTimeSeriesChart(timeseriesData);
      }
    }, 150);
  });
}

async function init() {
  try {
    const data = await fetchData();
    
    // Apply persisted theme first
    const theme = data.settings.theme || 'light';
    await applyTheme(theme);
    
    // Render all components
    renderStats(data.summary);
    renderCategories(data.categories);
    renderRecentTable(data.recent);
    
    // Draw chart
    drawTimeSeriesChart(data.timeseries);
    
    // Setup resize handler for chart
    setupResizeHandler(data.timeseries);
    
    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    
    // Initial resize to ensure chart fits
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 100);
    
  } catch (error) {
    console.error('Initialization failed:', error);
  }
}

// Boot the app
init();