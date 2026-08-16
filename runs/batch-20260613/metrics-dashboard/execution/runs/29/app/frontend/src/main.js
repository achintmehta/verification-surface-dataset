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
    applyTheme(theme);
  } catch (e) {
    applyTheme('light');
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

async function saveTheme(theme) {
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function setupThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
    // Redraw chart with new theme colors
    if (window.lastTimeseriesData) {
      drawTimeseriesChart(window.lastTimeseriesData);
    }
  });
}

async function loadSummary() {
  try {
    const data = await fetchJSON(`${API_BASE}/summary`);
    document.getElementById('total-visitors').textContent = data.totalVisitors.toLocaleString();
    document.getElementById('total-revenue').textContent = '$' + parseFloat(data.totalRevenue).toLocaleString();
    document.getElementById('best-day').textContent = data.bestDay || '-';
    const trendEl = document.getElementById('seven-day-trend');
    const trend = data.sevenDayTrend;
    trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
    trendEl.style.color = trend >= 0 ? '#22c55e' : '#ef4444';
  } catch (e) {
    showError('Failed to load summary data. Is the backend running?');
  }
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
}

async function loadTimeseries() {
  try {
    const data = await fetchJSON(`${API_BASE}/timeseries`);
    window.lastTimeseriesData = data;
    drawTimeseriesChart(data);
    
    // Redraw on resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (window.lastTimeseriesData) {
          drawTimeseriesChart(window.lastTimeseriesData);
        }
      }, 150);
    });
  } catch (e) {
    console.error('Failed to load timeseries', e);
  }
}

function drawTimeseriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  const container = svg.parentElement;
  
  // Get container width
  const width = container.clientWidth || 600;
  const height = 300;
  const margin = { top: 20, right: 30, bottom: 40, left: 50 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = '';

  if (!data || data.length === 0) return;

  const visitors = data.map(d => d.visitors);
  const maxVal = Math.max(...visitors);
  const minVal = Math.min(...visitors);
  const range = maxVal - minVal || 1;

  const isDark = currentTheme === 'dark';
  const gridColor = isDark ? '#475569' : '#e2e8f0';
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const lineColor = isDark ? '#60a5fa' : '#3b82f6';

  // Grid lines and Y axis labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = margin.top + (chartHeight * i / yTicks);
    const val = Math.round(maxVal - (range * i / yTicks));

    // Grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - margin.right);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', gridColor);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y label
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', margin.left - 10);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', textColor);
    label.setAttribute('font-size', '11');
    label.textContent = val.toLocaleString();
    svg.appendChild(label);
  }

  // X axis labels (every 5 days)
  const xStep = Math.ceil(data.length / 6);
  for (let i = 0; i < data.length; i += xStep) {
    const x = margin.left + (chartWidth * i / (data.length - 1));
    const date = new Date(data[i].date);
    const labelText = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', height - margin.bottom + 20);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', textColor);
    label.setAttribute('font-size', '11');
    label.textContent = labelText;
    svg.appendChild(label);

    // Tick
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('y1', height - margin.bottom);
    tick.setAttribute('x2', x);
    tick.setAttribute('y2', height - margin.bottom + 5);
    tick.setAttribute('stroke', gridColor);
    svg.appendChild(tick);
  }

  // X axis line
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', margin.left);
  xAxis.setAttribute('y1', height - margin.bottom);
  xAxis.setAttribute('x2', width - margin.right);
  xAxis.setAttribute('y2', height - margin.bottom);
  xAxis.setAttribute('stroke', gridColor);
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  // Y axis line
  const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  yAxis.setAttribute('x1', margin.left);
  yAxis.setAttribute('y1', margin.top);
  yAxis.setAttribute('x2', margin.left);
  yAxis.setAttribute('y2', height - margin.bottom);
  yAxis.setAttribute('stroke', gridColor);
  yAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(yAxis);

  // Line path
  let pathD = '';
  data.forEach((d, i) => {
    const x = margin.left + (chartWidth * i / (data.length - 1));
    const y = margin.top + chartHeight - (chartHeight * (d.visitors - minVal) / range);
    pathD += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
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
    const x = margin.left + (chartWidth * i / (data.length - 1));
    const y = margin.top + chartHeight - (chartHeight * (d.visitors - minVal) / range);
    
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', lineColor);
    svg.appendChild(dot);
  });
}

async function loadCategories() {
  try {
    const data = await fetchJSON(`${API_BASE}/categories`);
    const container = document.getElementById('categories-container');
    container.innerHTML = '';

    const maxVal = Math.max(...data.map(d => d.value));

    data.forEach(cat => {
      const row = document.createElement('div');
      row.className = 'category-row';

      const name = document.createElement('div');
      name.className = 'category-name';
      name.textContent = cat.name;
      name.title = cat.name; // for tooltip on long names

      const barContainer = document.createElement('div');
      barContainer.className = 'category-bar-container';

      const bar = document.createElement('div');
      bar.className = 'category-bar';
      const pct = (cat.value / maxVal) * 100;
      bar.style.width = pct + '%';

      const value = document.createElement('div');
      value.className = 'category-value';
      value.textContent = '$' + cat.value.toLocaleString();

      barContainer.appendChild(bar);
      row.appendChild(name);
      row.appendChild(barContainer);
      row.appendChild(value);
      container.appendChild(row);
    });
  } catch (e) {
    console.error('Failed to load categories', e);
  }
}

async function loadRecent() {
  try {
    const data = await fetchJSON(`${API_BASE}/recent`);
    const tbody = document.querySelector('#recent-table tbody');
    tbody.innerHTML = '';

    data.forEach(item => {
      const tr = document.createElement('tr');
      const date = new Date(item.created_at).toLocaleDateString();
      tr.innerHTML = `
        <td>${item.name}</td>
        <td>${item.category}</td>
        <td>$${parseFloat(item.value).toLocaleString()}</td>
        <td>${date}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Failed to load recent items', e);
  }
}

async function initDashboard() {
  await loadSettings();
  setupThemeToggle();

  // Load all data
  await Promise.all([
    loadSummary(),
    loadTimeseries(),
    loadCategories(),
    loadRecent()
  ]);
}

// Boot
initDashboard().catch(err => {
  console.error(err);
  showError('Failed to initialize dashboard. Backend may be unavailable.');
});