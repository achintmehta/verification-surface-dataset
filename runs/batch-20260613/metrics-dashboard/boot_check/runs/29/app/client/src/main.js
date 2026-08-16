const API_BASE = '/api';

let currentTheme = 'light';
let timeseriesData = [];
let resizeObserver = null;

async function fetchWithError(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    showError(`Failed to load data from server. Is the backend running?`);
    throw err;
  }
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.style.display = 'block';
}

function hideError() {
  const banner = document.getElementById('error-banner');
  banner.style.display = 'none';
}

async function loadSettings() {
  try {
    const { theme } = await fetchWithError(`${API_BASE}/settings`);
    applyTheme(theme);
  } catch (e) {
    applyTheme('light');
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const toggleBtn = document.getElementById('theme-toggle');
  toggleBtn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
}

async function saveTheme(theme) {
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to save theme');
  }
}

function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
    if (timeseriesData.length > 0) {
      drawTimeseriesChart(timeseriesData);
    }
  });
}

async function loadSummary() {
  const data = await fetchWithError(`${API_BASE}/summary`);
  
  document.getElementById('total-visitors').textContent = data.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + data.totalRevenue.toLocaleString();
  document.getElementById('best-day').textContent = data.bestDay || '-';
  
  const trendEl = document.getElementById('trend');
  const trendVal = data.trend || 0;
  trendEl.textContent = (trendVal >= 0 ? '+' : '') + trendVal + '%';
  trendEl.style.color = trendVal >= 0 ? 'var(--success)' : '#ef4444';
}

async function loadTimeseries() {
  timeseriesData = await fetchWithError(`${API_BASE}/timeseries`);
  drawTimeseriesChart(timeseriesData);
  setupChartResize();
}

function drawTimeseriesChart(data) {
  const canvas = document.getElementById('timeseries-chart');
  const ctx = canvas.getContext('2d');
  
  // Set actual size based on container for crisp rendering
  const container = document.getElementById('timeseries-container');
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  
  canvas.width = rect.width * dpr;
  canvas.height = 300 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '300px';
  
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = 300;
  const padding = { top: 20, right: 40, bottom: 50, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  ctx.clearRect(0, 0, width, height);
  
  if (!data || data.length === 0) return;
  
  const visitors = data.map(d => d.visitors);
  const minVal = Math.min(...visitors) * 0.9;
  const maxVal = Math.max(...visitors) * 1.1;
  const valRange = maxVal - minVal || 1;
  
  // Gridlines and Y axis labels
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim() || '#e2e8f0';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#64748b';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + (chartHeight * i / ySteps);
    const val = Math.round(maxVal - (valRange * i / ySteps));
    
    // Grid line
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    
    // Label
    ctx.fillText(val.toLocaleString(), padding.left - 8, y + 4);
  }
  
  // X axis labels (dates) - show every ~5 days
  ctx.textAlign = 'center';
  const xStep = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += xStep) {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const date = new Date(data[i].date);
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    
    ctx.fillText(label, x, height - padding.bottom + 20);
    
    // Tick
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#64748b';
    ctx.beginPath();
    ctx.moveTo(x, height - padding.bottom);
    ctx.lineTo(x, height - padding.bottom + 5);
    ctx.stroke();
  }
  
  // Draw line
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || '#3b82f6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  
  data.forEach((point, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight * (1 - (point.visitors - minVal) / valRange);
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // Draw points
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || '#3b82f6';
  data.forEach((point, i) => {
    const x = padding.left + (chartWidth * i / (data.length - 1));
    const y = padding.top + chartHeight * (1 - (point.visitors - minVal) / valRange);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
  
  // Axes
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#64748b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();
}

function setupChartResize() {
  const container = document.getElementById('timeseries-container');
  
  if (resizeObserver) resizeObserver.disconnect();
  
  resizeObserver = new ResizeObserver(() => {
    if (timeseriesData.length > 0) {
      drawTimeseriesChart(timeseriesData);
    }
  });
  
  resizeObserver.observe(container);
  
  // Also on window resize as fallback
  window.addEventListener('resize', () => {
    if (timeseriesData.length > 0) {
      drawTimeseriesChart(timeseriesData);
    }
  }, { once: false, passive: true });
}

async function loadCategories() {
  const data = await fetchWithError(`${API_BASE}/categories`);
  const container = document.getElementById('categories-container');
  container.innerHTML = '';
  
  const maxVal = Math.max(...data.map(c => c.value));
  
  data.forEach(cat => {
    const pct = (cat.value / maxVal) * 100;
    
    const item = document.createElement('div');
    item.className = 'category-item';
    
    item.innerHTML = `
      <div class="category-header">
        <div class="category-name" title="${cat.name}">${cat.name}</div>
        <div class="category-value">$${(cat.value / 1000).toFixed(0)}k</div>
      </div>
      <div class="category-bar-container">
        <div class="category-bar" style="width: ${pct}%"></div>
      </div>
    `;
    
    container.appendChild(item);
  });
}

async function loadRecent() {
  const data = await fetchWithError(`${API_BASE}/recent`);
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';
  
  data.forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${item.created_at}</td>
    `;
    tbody.appendChild(row);
  });
}

async function initDashboard() {
  hideError();
  
  try {
    await loadSettings();
    setupThemeToggle();
    
    await Promise.all([
      loadSummary(),
      loadTimeseries(),
      loadCategories(),
      loadRecent()
    ]);
  } catch (err) {
    console.error('Dashboard init failed:', err);
  }
}

// Boot
document.addEventListener('DOMContentLoaded', initDashboard);