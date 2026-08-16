const API_BASE = '/api';

let currentTheme = 'light';
let timeseriesData = [];
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
  } catch (err) {
    console.error('Fetch error:', err);
    throw err;
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  
  // Redraw chart with new theme colors
  if (timeseriesData.length > 0) {
    drawTimeSeriesChart(timeseriesData);
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
    applyTheme(newTheme);
  } catch (err) {
    console.error('Failed to save theme:', err);
    // Apply anyway for UX
    applyTheme(newTheme);
  }
}

function renderSummary(summary) {
  document.getElementById('total-visitors').textContent = 
    summary.totalVisitors.toLocaleString();
  
  document.getElementById('total-revenue').textContent = 
    '$' + parseFloat(summary.totalRevenue).toLocaleString();
  
  document.getElementById('best-day').textContent = summary.bestDay;
  document.getElementById('best-day-visitors').textContent = 
    summary.bestDayVisitors.toLocaleString() + ' visitors';
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = parseFloat(summary.sevenDayTrend);
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

function drawTimeSeriesChart(data) {
  timeseriesData = data;
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

  // Clear previous content
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  if (data.length === 0) return;

  const padding = { top: 20, right: 30, bottom: 40, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

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

  // X axis labels (every 5 days)
  const xStep = Math.ceil(data.length / 6);
  for (let i = 0; i < data.length; i += xStep) {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const date = data[i].date;

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
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
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

  // Draw dots
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--card-bg)');
    circle.setAttribute('stroke', 'var(--chart-line)');
    circle.setAttribute('stroke-width', '2');
    svg.appendChild(circle);
  });
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';

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
    const percent = (cat.value / maxValue) * 100;
    bar.style.width = percent + '%';

    barContainer.appendChild(bar);

    item.appendChild(header);
    item.appendChild(barContainer);
    container.appendChild(item);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
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

function setupResizeHandler() {
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (timeseriesData.length > 0) {
        drawTimeSeriesChart(timeseriesData);
      }
    }, 150);
  });
}

async function init() {
  const errorState = document.getElementById('error-state');
  const dashboard = document.getElementById('dashboard');
  const themeToggle = document.getElementById('theme-toggle');

  themeToggle.addEventListener('click', toggleTheme);

  try {
    const data = await fetchData();
    
    // Apply persisted theme before paint
    applyTheme(data.settings.theme || 'light');
    
    renderSummary(data.summary);
    renderCategories(data.categories);
    renderRecent(data.recent);
    drawTimeSeriesChart(data.timeseries);
    
    setupResizeHandler();
    
    errorState.classList.add('hidden');
    dashboard.classList.remove('hidden');
  } catch (err) {
    errorState.classList.remove('hidden');
    dashboard.classList.add('hidden');
  }
}

init();