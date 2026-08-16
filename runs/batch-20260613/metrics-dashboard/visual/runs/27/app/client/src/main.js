// Main dashboard logic
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
    applyTheme(theme);
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toggle = document.getElementById('theme-toggle');
  if (toggle) toggle.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
}

function createStatCard(title, value, sub = '') {
  const card = document.createElement('div');
  card.className = 'stat-card';
  card.innerHTML = `
    <div class="stat-label">${title}</div>
    <div class="stat-value">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  `;
  return card;
}

function formatNumber(n) {
  return n.toLocaleString();
}

function formatCurrency(n) {
  return '$' + n.toLocaleString();
}

async function renderSummary() {
  const container = document.getElementById('summary');
  container.innerHTML = '';
  try {
    const data = await fetchJSON(`${API_BASE}/summary`);
    const cards = [
      createStatCard('Total Visitors', formatNumber(data.totalVisitors)),
      createStatCard('Total Revenue', formatCurrency(data.totalRevenue)),
      createStatCard('Best Day', data.bestDay || '-', `${formatNumber(data.bestDayVisitors)} visitors`),
      createStatCard('7-Day Trend', `${data.sevenDayTrend >= 0 ? '+' : ''}${data.sevenDayTrend}%`, data.sevenDayTrend >= 0 ? '↑ Up' : '↓ Down')
    ];
    cards.forEach(c => container.appendChild(c));
  } catch (e) {
    container.innerHTML = '<div class="error">Failed to load summary. Is the server running?</div>';
  }
}

function drawTimeSeriesChart(canvas, data) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = 300 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = rect.width;
  const h = 300;
  ctx.clearRect(0, 0, w, h);

  if (!data || data.length === 0) return;

  const padding = { top: 20, right: 40, bottom: 40, left: 60 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  const visitors = data.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const rangeV = maxV - minV || 1;

  // Draw gridlines and y ticks
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim() || '#e5e7eb';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#6b7280';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'right';
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartH * i / yTicks);
    const val = Math.round(maxV - (rangeV * i / yTicks));
    ctx.fillText(formatNumber(val), padding.left - 8, y + 4);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }

  // X axis labels (every 5 days)
  ctx.textAlign = 'center';
  for (let i = 0; i < data.length; i += 5) {
    const x = padding.left + (chartW * i / (data.length - 1));
    const label = data[i].date.slice(5); // MM-DD
    ctx.fillText(label, x, h - padding.bottom + 20);
  }

  // Draw line
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || '#3b82f6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = padding.left + (chartW * i / (data.length - 1));
    const y = padding.top + chartH * (1 - (data[i].visitors - minV) / rangeV);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Draw points
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || '#3b82f6';
  for (let i = 0; i < data.length; i++) {
    const x = padding.left + (chartW * i / (data.length - 1));
    const y = padding.top + chartH * (1 - (data[i].visitors - minV) / rangeV);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Axes
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#9ca3af';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, h - padding.bottom);
  ctx.lineTo(w - padding.right, h - padding.bottom);
  ctx.stroke();
}

async function renderTimeSeries() {
  const container = document.getElementById('timeseries');
  container.innerHTML = '<canvas id="ts-canvas"></canvas>';
  const canvas = document.getElementById('ts-canvas');
  try {
    const data = await fetchJSON(`${API_BASE}/timeseries`);
    const resizeObserver = new ResizeObserver(() => {
      drawTimeSeriesChart(canvas, data);
    });
    resizeObserver.observe(container);
    // Initial draw
    setTimeout(() => drawTimeSeriesChart(canvas, data), 50);
    window.addEventListener('resize', () => drawTimeSeriesChart(canvas, data), { once: false });
  } catch (e) {
    container.innerHTML = '<div class="error">Failed to load time series.</div>';
  }
}

function drawCategoryBars(container, data) {
  container.innerHTML = '';
  const maxVal = Math.max(...data.map(d => d.value));
  data.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-row';
    const pct = (cat.value / maxVal) * 100;
    row.innerHTML = `
      <div class="cat-name" title="${cat.name}">${cat.name}</div>
      <div class="cat-bar-container">
        <div class="cat-bar" style="width: ${pct}%"></div>
      </div>
      <div class="cat-value">${formatNumber(cat.value)}</div>
    `;
    container.appendChild(row);
  });
}

async function renderCategories() {
  const container = document.getElementById('categories');
  try {
    const data = await fetchJSON(`${API_BASE}/categories`);
    drawCategoryBars(container, data);
  } catch (e) {
    container.innerHTML = '<div class="error">Failed to load categories.</div>';
  }
}

async function renderRecentTable() {
  const container = document.getElementById('recent');
  try {
    const data = await fetchJSON(`${API_BASE}/recent`);
    let html = `
      <table>
        <thead>
          <tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr>
        </thead>
        <tbody>
    `;
    data.forEach(item => {
      const date = new Date(item.created_at).toISOString().split('T')[0];
      html += `<tr>
        <td>${item.name}</td>
        <td>${item.category}</td>
        <td>${formatCurrency(item.value)}</td>
        <td>${date}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="error">Failed to load recent items.</div>';
  }
}

function setupThemeToggle() {
  const header = document.querySelector('header');
  const toggle = document.createElement('button');
  toggle.id = 'theme-toggle';
  toggle.className = 'theme-toggle';
  toggle.addEventListener('click', () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    saveTheme(newTheme);
  });
  header.appendChild(toggle);
}

async function initDashboard() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <header>
      <h1>Metrics Dashboard</h1>
    </header>
    <div class="dashboard">
      <div id="summary" class="stats-grid"></div>
      <div class="main-grid">
        <div class="card">
          <h2>30-Day Visitors Trend</h2>
          <div id="timeseries" class="chart-container"></div>
        </div>
        <div class="card">
          <h2>Category Breakdown</h2>
          <div id="categories" class="categories"></div>
        </div>
      </div>
      <div class="card">
        <h2>Recent Items</h2>
        <div id="recent" class="table-container"></div>
      </div>
    </div>
  `;

  setupThemeToggle();
  await loadSettings();
  await renderSummary();
  await renderTimeSeries();
  await renderCategories();
  await renderRecentTable();
}

initDashboard();