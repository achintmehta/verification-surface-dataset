// API base URL - works with Vite proxy in dev, relative in production
const API_BASE = '/api';

// State
let currentTheme = 'light';
let timeseriesData = [];
let chartResizeObserver = null;

// ===== API Functions =====
async function fetchJSON(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${API_BASE}${endpoint}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function putJSON(endpoint, body) {
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ===== Theme =====
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
  // Redraw chart with new colours
  if (timeseriesData.length > 0) {
    drawTimeseriesChart(timeseriesData);
  }
}

async function loadTheme() {
  try {
    const settings = await fetchJSON('/settings');
    applyTheme(settings.theme || 'light');
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await putJSON('/settings', { theme: newTheme });
  } catch (e) {
    console.error('Failed to persist theme:', e);
  }
}

// ===== Formatting =====
function formatNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatDateFull(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// ===== Render Summary Cards =====
function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('stat-best-day').textContent = formatCurrency(data.bestDay.revenue);
  document.getElementById('stat-best-day-sub').textContent = formatDateFull(data.bestDay.date);

  const trendEl = document.getElementById('stat-trend');
  const trendVal = data.sevenDayTrend;
  const sign = trendVal >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${trendVal}%`;
  trendEl.className = 'stat-value ' + (trendVal >= 0 ? 'trend-positive' : 'trend-negative');

  const trendSub = document.getElementById('stat-trend-sub');
  trendSub.textContent = 'vs previous 7 days';
  trendSub.className = 'stat-sub ' + (trendVal >= 0 ? 'positive' : 'negative');
}

// ===== Draw Timeseries Chart (Canvas) =====
function drawTimeseriesChart(data) {
  const container = document.getElementById('timeseries-container');
  const canvas = document.getElementById('timeseries-canvas');
  if (!container || !canvas) return;

  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width;
  const height = rect.height;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Read theme colours from CSS vars
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const fillColor = style.getPropertyValue('--chart-fill').trim();
  const dotColor = style.getPropertyValue('--chart-dot').trim();
  const textColor = style.getPropertyValue('--text-secondary').trim();

  // Margins
  const marginLeft = 52;
  const marginRight = 16;
  const marginTop = 16;
  const marginBottom = 40;

  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  const visitors = data.map(d => d.visitors);
  const minVal = Math.min(...visitors);
  const maxVal = Math.max(...visitors);
  const range = maxVal - minVal || 1;
  const padding = range * 0.1;
  const yMin = Math.max(0, Math.floor((minVal - padding) / 500) * 500);
  const yMax = Math.ceil((maxVal + padding) / 500) * 500;
  const yRange = yMax - yMin || 1;

  // Clear
  ctx.clearRect(0, 0, width, height);

  // Y grid lines & labels
  const yTicks = 5;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (yRange / yTicks) * i;
    const y = marginTop + plotH - (plotH * (val - yMin) / yRange);

    // Grid line
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + plotW, y);
    ctx.stroke();

    // Label
    ctx.fillStyle = axisColor;
    ctx.fillText(formatNumber(Math.round(val)), marginLeft - 8, y);
  }

  // X axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelCount = width < 500 ? 5 : (width < 800 ? 8 : 10);
  const step = Math.max(1, Math.floor(data.length / labelCount));

  for (let i = 0; i < data.length; i += step) {
    const x = marginLeft + (plotW * i / (data.length - 1));
    const label = formatDate(data[i].date);
    ctx.fillStyle = axisColor;
    ctx.fillText(label, x, marginTop + plotH + 8);
  }
  // Always show last label
  if (data.length > 1) {
    const lastX = marginLeft + plotW;
    ctx.fillStyle = axisColor;
    ctx.fillText(formatDate(data[data.length - 1].date), lastX, marginTop + plotH + 8);
  }

  // Draw fill area
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = marginLeft + (plotW * i / (data.length - 1));
    const y = marginTop + plotH - (plotH * (data[i].visitors - yMin) / yRange);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);
  ctx.lineTo(marginLeft, marginTop + plotH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = marginLeft + (plotW * i / (data.length - 1));
    const y = marginTop + plotH - (plotH * (data[i].visitors - yMin) / yRange);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Draw dots
  for (let i = 0; i < data.length; i++) {
    const x = marginLeft + (plotW * i / (data.length - 1));
    const y = marginTop + plotH - (plotH * (data[i].visitors - yMin) / yRange);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }

  // Axis lines
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + plotH);
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);
  ctx.stroke();
}

// ===== Render Categories =====
function renderCategories(data) {
  const container = document.getElementById('categories-container');
  if (!container) return;

  const maxVal = Math.max(...data.map(d => d.value));

  container.innerHTML = data.map(cat => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    return `
      <div class="category-row">
        <div class="category-header">
          <span class="category-name" title="${cat.name}">${cat.name}</span>
          <span class="category-value">${formatNumber(cat.value)}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ===== Render Recent Table =====
function renderRecentTable(data) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  tbody.innerHTML = data.map(item => {
    const date = new Date(item.created_at);
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
    });
    return `
      <tr>
        <td class="cell-name">${item.name}</td>
        <td class="cell-category" title="${item.category}">${item.category}</td>
        <td class="cell-value">${formatCurrency(parseFloat(item.value))}</td>
        <td class="cell-date">${dateStr}</td>
      </tr>
    `;
  }).join('');
}

// ===== Chart Resize Handling =====
function setupChartResize() {
  const container = document.getElementById('timeseries-container');
  if (!container) return;

  // Use ResizeObserver for robust resize detection
  if (window.ResizeObserver) {
    if (chartResizeObserver) chartResizeObserver.disconnect();
    chartResizeObserver = new ResizeObserver(() => {
      if (timeseriesData.length > 0) {
        drawTimeseriesChart(timeseriesData);
      }
    });
    chartResizeObserver.observe(container);
  } else {
    // Fallback: listen to window resize
    window.addEventListener('resize', () => {
      if (timeseriesData.length > 0) {
        drawTimeseriesChart(timeseriesData);
      }
    });
  }
}

// ===== Init =====
async function init() {
  // Load theme first (before first paint of data)
  await loadTheme();

  // Set up theme toggle
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleTheme);

  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent')
    ]);

    // Hide loading, show content
    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';

    // Render everything
    renderSummary(summary);

    timeseriesData = timeseries;
    renderCategories(categories);
    renderRecentTable(recent);

    // Draw chart after layout has settled
    requestAnimationFrame(() => {
      drawTimeseriesChart(timeseriesData);
      setupChartResize();
    });

  } catch (err) {
    console.error('Failed to load dashboard:', err);
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'flex';
  }
}

// Start
document.addEventListener('DOMContentLoaded', init);
