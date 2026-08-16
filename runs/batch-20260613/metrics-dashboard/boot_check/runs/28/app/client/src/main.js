const API_BASE = '/api';

let currentTheme = 'light';

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSettings() {
  try {
    const settings = await fetchJSON(`${API_BASE}/settings`);
    currentTheme = settings.theme || 'light';
    applyTheme(currentTheme);
  } catch (e) {
    console.error('Failed to load settings', e);
    applyTheme('light');
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  currentTheme = theme;
}

async function saveTheme(theme) {
  try {
    await fetchJSON(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
    // Redraw chart with new theme colors
    if (window.lastChartData) {
      drawTimeSeriesChart(window.lastChartData);
    }
  });
}

async function loadSummary() {
  const container = document.getElementById('stats');
  try {
    const data = await fetchJSON(`${API_BASE}/summary`);
    container.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Visitors</div>
        <div class="stat-value">${data.totalVisitors.toLocaleString()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value">$${(data.totalRevenue / 1000).toFixed(0)}k</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Best Day</div>
        <div class="stat-value">${data.bestDay.visitors.toLocaleString()}</div>
        <div class="stat-label">${new Date(data.bestDay.date).toLocaleDateString()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">7-Day Trend</div>
        <div class="stat-value">${data.sevenDayTrend > 0 ? '+' : ''}${data.sevenDayTrend}%</div>
        <div class="stat-trend">${data.sevenDayTrend >= 0 ? '↑ Up' : '↓ Down'}</div>
      </div>
    `;
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load summary: ${e.message}</div>`;
  }
}

function drawTimeSeriesChart(data) {
  window.lastChartData = data;
  const svg = document.getElementById('timeseries-chart');
  const container = document.getElementById('chart-container');
  
  // Clear previous
  svg.innerHTML = '';
  
  const width = container.clientWidth || 600;
  const height = 300;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const yRange = maxVisitors - minVisitors || 1;
  
  const isDark = currentTheme === 'dark';
  const gridColor = isDark ? '#475569' : '#e2e8f0';
  const lineColor = isDark ? '#60a5fa' : '#3b82f6';
  const textColor = isDark ? '#94a3b8' : '#64748b';
  
  // Grid lines and Y axis labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartHeight * i / yTicks);
    const val = Math.round(maxVisitors - (yRange * i / yTicks));
    
    // Horizontal grid
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
    text.setAttribute('fill', textColor);
    text.setAttribute('font-size', '12');
    text.textContent = val.toLocaleString();
    svg.appendChild(text);
  }
  
  // X axis labels (every 5 days)
  const n = data.length;
  for (let i = 0; i < n; i += 5) {
    const x = padding.left + (chartWidth * i / (n - 1));
    const date = new Date(data[i].date);
    
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', padding.top);
    line.setAttribute('x2', x);
    line.setAttribute('y2', height - padding.bottom);
    line.setAttribute('stroke', gridColor);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - padding.bottom + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', textColor);
    text.setAttribute('font-size', '11');
    text.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.appendChild(text);
  }
  
  // Draw the line
  let pathD = '';
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (n - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    pathD += (i === 0 ? 'M' : 'L') + `${x},${y} `;
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
    const x = padding.left + (chartWidth * i / (n - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / yRange);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', lineColor);
    svg.appendChild(circle);
  });
}

async function loadTimeSeries() {
  const container = document.getElementById('chart-container');
  try {
    const data = await fetchJSON(`${API_BASE}/timeseries`);
    drawTimeSeriesChart(data);
    
    // Redraw on resize
    const resizeObserver = new ResizeObserver(() => {
      if (window.lastChartData) {
        drawTimeSeriesChart(window.lastChartData);
      }
    });
    resizeObserver.observe(container);
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load chart: ${e.message}</div>`;
  }
}

async function loadCategories() {
  const container = document.getElementById('categories');
  try {
    const data = await fetchJSON(`${API_BASE}/categories`);
    const maxVal = Math.max(...data.map(d => d.value));
    
    container.innerHTML = data.map(cat => `
      <div class="category-item">
        <div class="category-name" title="${cat.name}">${cat.name}</div>
        <div class="category-bar-container">
          <div class="category-bar" style="width: ${Math.max(5, (cat.value / maxVal) * 100)}%"></div>
        </div>
        <div class="category-value">${(cat.value / 1000).toFixed(0)}k</div>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load categories: ${e.message}</div>`;
  }
}

async function loadRecent() {
  const container = document.getElementById('recent-table');
  try {
    const data = await fetchJSON(`${API_BASE}/recent`);
    let html = `<table>
      <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr></thead>
      <tbody>`;
    data.forEach(item => {
      const date = new Date(item.created_at).toLocaleDateString();
      html += `<tr>
        <td>${item.name}</td>
        <td>${item.category}</td>
        <td>$${item.value.toLocaleString()}</td>
        <td>${date}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load recent items: ${e.message}</div>`;
  }
}

async function initDashboard() {
  await loadSettings();
  setupThemeToggle();
  
  // Load all data
  await Promise.all([
    loadSummary(),
    loadTimeSeries(),
    loadCategories(),
    loadRecent()
  ]);
}

initDashboard().catch(err => {
  console.error(err);
  document.getElementById('dashboard').innerHTML = 
    `<div class="error">Dashboard failed to load. Is the server running?</div>`;
});