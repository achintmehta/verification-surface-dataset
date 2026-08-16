const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchData(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`Failed to fetch ${endpoint}`);
  return res.json();
}

async function loadSettings() {
  try {
    const settings = await fetchData('/settings');
    applyTheme(settings.theme || 'light');
  } catch (e) {
    applyTheme('light');
  }
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

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
  }
  // Redraw chart if exists
  if (window.lastTimeseriesData) {
    drawTimeseriesChart(window.lastTimeseriesData);
  }
}

function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
  });
}

async function loadSummary() {
  const data = await fetchData('/summary');
  document.getElementById('total-visitors').textContent = data.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + parseFloat(data.totalRevenue).toLocaleString();
  document.getElementById('best-day').textContent = data.bestDay;
  const trendEl = document.getElementById('seven-day-trend');
  const trend = data.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? '#22c55e' : '#ef4444';
}

async function loadTimeseries() {
  const data = await fetchData('/timeseries');
  window.lastTimeseriesData = data;
  drawTimeseriesChart(data);
}

function drawTimeseriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg || !data.length) return;

  // Clear previous
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 800;
  const height = 300;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const maxVisitors = Math.max(...data.map(d => d.visitors));
  const minVisitors = Math.min(...data.map(d => d.visitors));
  const range = maxVisitors - minVisitors || 1;

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Gridlines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartHeight * i / yTicks);
    const val = Math.round(maxVisitors - (range * i / yTicks));

    // grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // y label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', padding.left - 10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '12');
    text.textContent = val.toLocaleString();
    svg.appendChild(text);
  }

  // X axis labels (every 5 days)
  const xStep = Math.floor(data.length / 6) || 1;
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
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '11');
    text.textContent = date.slice(5); // MM-DD
    svg.appendChild(text);
  }

  // Line path
  let pathD = '';
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / range);
    pathD += (i === 0 ? 'M' : 'L') + `${x},${y} `;
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
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minVisitors) / range);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });
}

function setupResizeHandler() {
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (window.lastTimeseriesData) {
        drawTimeseriesChart(window.lastTimeseriesData);
      }
    }, 150);
  });
}

async function loadCategories() {
  const data = await fetchData('/categories');
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  const maxVal = Math.max(...data.map(d => d.value));

  data.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-row';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // for tooltip if truncated

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    const pct = (cat.value / maxVal) * 100;
    bar.style.width = `${pct}%`;

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    barContainer.appendChild(bar);
    row.appendChild(name);
    row.appendChild(barContainer);
    row.appendChild(value);
    container.appendChild(row);
  });
}

async function loadRecent() {
  const data = await fetchData('/recent');
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';

  data.forEach(item => {
    const tr = document.createElement('tr');
    const date = new Date(item.created_at).toISOString().split('T')[0];
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadDashboard() {
  const errorEl = document.getElementById('error');
  errorEl.classList.add('hidden');

  try {
    await Promise.all([
      loadSummary(),
      loadTimeseries(),
      loadCategories(),
      loadRecent()
    ]);
  } catch (e) {
    errorEl.textContent = 'Error loading dashboard data. Is the backend running?';
    errorEl.classList.remove('hidden');
    console.error(e);
  }
}

async function init() {
  await loadSettings();
  setupThemeToggle();
  setupResizeHandler();
  await loadDashboard();
}

init();