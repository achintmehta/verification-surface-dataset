const API_BASE = '/api';

let currentTheme = 'light';

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
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
    // Redraw chart with new theme
    if (window.lastTimeseriesData) {
      drawTimeSeriesChart(window.lastTimeseriesData);
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
    trendEl.style.color = trend >= 0 ? 'var(--success)' : 'var(--danger)';
  } catch (e) {
    showError('Failed to load summary data. Is the backend running?');
  }
}

async function loadTimeSeries() {
  try {
    const data = await fetchJSON(`${API_BASE}/timeseries`);
    window.lastTimeseriesData = data;
    drawTimeSeriesChart(data);
    setupResizeHandler();
  } catch (e) {
    showError('Failed to load time series data.');
  }
}

function drawTimeSeriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg || !data.length) return;

  // Clear previous
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const margin = { top: 20, right: 30, bottom: 40, left: 50 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const padding = (maxVisitors - minVisitors) * 0.1 || 100;

  const yMin = Math.max(0, minVisitors - padding);
  const yMax = maxVisitors + padding;

  // Create group
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('transform', `translate(${margin.left},${margin.top})`);

  // Gridlines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = chartHeight - (i / yTicks) * chartHeight;
    const value = Math.round(yMin + (yMax - yMin) * (i / yTicks));

    // Grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 0);
    line.setAttribute('y1', y);
    line.setAttribute('x2', chartWidth);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--border)');
    line.setAttribute('stroke-width', '1');
    g.appendChild(line);

    // Y label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', -10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '11');
    text.textContent = value.toLocaleString();
    g.appendChild(text);
  }

  // X axis labels (every 5 days)
  const xStep = Math.ceil(data.length / 6);
  data.forEach((d, i) => {
    if (i % xStep === 0 || i === data.length - 1) {
      const x = (i / (data.length - 1)) * chartWidth;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x);
      text.setAttribute('y', chartHeight + 20);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'var(--text-muted)');
      text.setAttribute('font-size', '10');
      const date = new Date(d.date);
      text.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      g.appendChild(text);

      // Tick
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', x);
      tick.setAttribute('y1', chartHeight);
      tick.setAttribute('x2', x);
      tick.setAttribute('y2', chartHeight + 5);
      tick.setAttribute('stroke', 'var(--border)');
      tick.setAttribute('stroke-width', '1');
      g.appendChild(tick);
    }
  });

  // Line path
  let pathD = '';
  data.forEach((d, i) => {
    const x = (i / (data.length - 1)) * chartWidth;
    const y = chartHeight - ((d.visitors - yMin) / (yMax - yMin)) * chartHeight;
    pathD += (i === 0 ? 'M' : 'L') + `${x},${y} `;
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD.trim());
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--primary)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  g.appendChild(path);

  // Dots
  data.forEach((d, i) => {
    const x = (i / (data.length - 1)) * chartWidth;
    const y = chartHeight - ((d.visitors - yMin) / (yMax - yMin)) * chartHeight;
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--primary)');
    g.appendChild(circle);
  });

  // X axis line
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', 0);
  xAxis.setAttribute('y1', chartHeight);
  xAxis.setAttribute('x2', chartWidth);
  xAxis.setAttribute('y2', chartHeight);
  xAxis.setAttribute('stroke', 'var(--border)');
  xAxis.setAttribute('stroke-width', '1.5');
  g.appendChild(xAxis);

  // Y axis line
  const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  yAxis.setAttribute('x1', 0);
  yAxis.setAttribute('y1', 0);
  yAxis.setAttribute('x2', 0);
  yAxis.setAttribute('y2', chartHeight);
  yAxis.setAttribute('stroke', 'var(--border)');
  yAxis.setAttribute('stroke-width', '1.5');
  g.appendChild(yAxis);

  svg.appendChild(g);
}

function setupResizeHandler() {
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (window.lastTimeseriesData) {
        drawTimeSeriesChart(window.lastTimeseriesData);
      }
    }, 150);
  });
}

async function loadCategories() {
  try {
    const data = await fetchJSON(`${API_BASE}/categories`);
    const container = document.getElementById('categories-container');
    container.innerHTML = '';

    const maxValue = Math.max(...data.map(d => d.value));

    data.forEach(cat => {
      const item = document.createElement('div');
      item.className = 'category-item';

      const name = document.createElement('div');
      name.className = 'category-name';
      name.textContent = cat.name;
      name.title = cat.name; // for tooltip

      const barContainer = document.createElement('div');
      barContainer.className = 'category-bar-container';

      const bar = document.createElement('div');
      bar.className = 'category-bar';
      const percent = (cat.value / maxValue) * 100;
      bar.style.width = `${percent}%`;

      const value = document.createElement('div');
      value.className = 'category-value';
      value.textContent = cat.value.toLocaleString();

      barContainer.appendChild(bar);
      item.appendChild(name);
      item.appendChild(barContainer);
      item.appendChild(value);
      container.appendChild(item);
    });
  } catch (e) {
    showError('Failed to load categories.');
  }
}

async function loadRecent() {
  try {
    const data = await fetchJSON(`${API_BASE}/recent`);
    const tbody = document.querySelector('#recent-table tbody');
    tbody.innerHTML = '';

    data.forEach(item => {
      const row = document.createElement('tr');
      const date = new Date(item.created_at).toLocaleDateString();
      row.innerHTML = `
        <td>${item.name}</td>
        <td>${item.category}</td>
        <td>$${parseFloat(item.value).toFixed(2)}</td>
        <td>${date}</td>
      `;
      tbody.appendChild(row);
    });
  } catch (e) {
    showError('Failed to load recent items.');
  }
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
}

async function initDashboard() {
  await loadSettings();
  setupThemeToggle();

  try {
    await Promise.all([
      loadSummary(),
      loadTimeSeries(),
      loadCategories(),
      loadRecent()
    ]);
  } catch (e) {
    // errors handled in each loader
  }
}

// Boot
initDashboard();