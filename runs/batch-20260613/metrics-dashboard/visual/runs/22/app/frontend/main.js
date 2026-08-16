// ============================================
// API Client
// ============================================
const API_BASE = '/api';

async function fetchJSON(url) {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function putJSON(url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ============================================
// Theme Management
// ============================================
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-toggle__icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
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

// ============================================
// Number Formatting
// ============================================
function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function formatCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// ============================================
// Stat Cards
// ============================================
function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);
  
  if (data.bestDay) {
    document.getElementById('stat-bestday').textContent = formatNumber(data.bestDay.visitors);
    document.getElementById('stat-bestday-sub').textContent = formatDate(data.bestDay.date);
  }

  const trendValue = data.trend;
  const trendEl = document.getElementById('stat-trend');
  const indicatorEl = document.getElementById('stat-trend-indicator');
  trendEl.textContent = `${Math.abs(trendValue).toFixed(1)}%`;
  
  if (trendValue >= 0) {
    indicatorEl.textContent = '↑ Up';
    indicatorEl.className = 'stat-card__indicator up';
  } else {
    indicatorEl.textContent = '↓ Down';
    indicatorEl.className = 'stat-card__indicator down';
  }
}

// ============================================
// Time Series Chart (Canvas)
// ============================================
let timeseriesData = null;

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue('--chart-grid').trim(),
    axis: style.getPropertyValue('--chart-axis').trim(),
    line: style.getPropertyValue('--chart-line').trim(),
    fill: style.getPropertyValue('--chart-fill').trim(),
    dot: style.getPropertyValue('--chart-dot').trim(),
    bg: style.getPropertyValue('--bg-card').trim(),
    text: style.getPropertyValue('--text-primary').trim(),
    textSecondary: style.getPropertyValue('--text-secondary').trim(),
  };
}

function drawTimeseriesChart() {
  if (!timeseriesData || timeseriesData.length === 0) return;

  const canvas = document.getElementById('timeseries-chart');
  const container = document.getElementById('timeseries-container');
  if (!canvas || !container) return;

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

  const colors = getThemeColors();

  // Padding
  const padLeft = 52;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 40;

  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  if (chartW <= 0 || chartH <= 0) return;

  // Clear
  ctx.clearRect(0, 0, width, height);

  const data = timeseriesData;
  const values = data.map(d => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const niceMin = Math.floor(minVal / 500) * 500;
  const niceMax = Math.ceil(maxVal / 500) * 500;
  const niceRange = niceMax - niceMin || 1;

  // Y scale
  function yScale(v) {
    return padTop + chartH - ((v - niceMin) / niceRange) * chartH;
  }
  // X scale
  function xScale(i) {
    return padLeft + (i / (data.length - 1)) * chartW;
  }

  // Gridlines & Y axis labels
  const yTicks = 5;
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = colors.textSecondary || colors.axis;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= yTicks; i++) {
    const val = niceMin + (niceRange / yTicks) * i;
    const y = yScale(val);
    
    // gridline
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // label
    ctx.fillText(formatNumber(Math.round(val)), padLeft - 6, y);
  }

  // X axis labels - adaptive count, always including first and last
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelWidth = 48; // approx width of a date label like "Jan 30"
  const maxLabels = Math.max(2, Math.floor(chartW / labelWidth));
  const lastIdx = data.length - 1;
  
  // Generate evenly-spaced label indices, always including 0 and lastIdx
  const labelIndices = [0];
  if (maxLabels > 2) {
    const step = lastIdx / (maxLabels - 1);
    for (let i = 1; i < maxLabels - 1; i++) {
      labelIndices.push(Math.round(step * i));
    }
  }
  labelIndices.push(lastIdx);
  
  // Remove duplicates and sort
  const uniqueIndices = [...new Set(labelIndices)].sort((a, b) => a - b);
  
  for (const i of uniqueIndices) {
    const x = xScale(i);
    ctx.fillText(formatDate(data[i].date), x, height - padBottom + 8);
    
    // tick
    ctx.beginPath();
    ctx.strokeStyle = colors.axis;
    ctx.moveTo(x, padTop + chartH);
    ctx.lineTo(x, padTop + chartH + 4);
    ctx.stroke();
  }

  // Axis lines
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padLeft, padTop);
  ctx.lineTo(padLeft, padTop + chartH);
  ctx.lineTo(width - padRight, padTop + chartH);
  ctx.stroke();

  // Area fill
  ctx.beginPath();
  ctx.moveTo(xScale(0), padTop + chartH);
  for (let i = 0; i < data.length; i++) {
    ctx.lineTo(xScale(i), yScale(data[i].visitors));
  }
  ctx.lineTo(xScale(data.length - 1), padTop + chartH);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i].visitors);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Dots
  ctx.fillStyle = colors.dot;
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i].visitors);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================
// Categories Breakdown
// ============================================
function renderCategories(data) {
  const container = document.getElementById('categories-container');
  if (!container) return;

  const maxVal = Math.max(...data.map(c => c.value));
  
  container.innerHTML = data.map(cat => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    return `
      <div class="category-row">
        <div class="category-row__header">
          <span class="category-row__name" title="${cat.name}">${cat.name}</span>
          <span class="category-row__value">${formatNumber(cat.value)}</span>
        </div>
        <div class="category-row__bar-bg">
          <div class="category-row__bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// Recent Items Table
// ============================================
function renderRecentItems(data) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  tbody.innerHTML = data.map(item => `
    <tr>
      <td title="${item.name}">${item.name}</td>
      <td title="${item.category}">${item.category}</td>
      <td class="numeric">${formatCurrency(item.value)}</td>
      <td>${formatDateTime(item.createdAt)}</td>
    </tr>
  `).join('');
}

// ============================================
// Resize Handler
// ============================================
let resizeTimeout = null;
function onResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    drawTimeseriesChart();
  }, 100);
}

// ============================================
// Initialize
// ============================================
async function init() {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  // Load theme first (before data)
  await loadTheme();

  // Setup theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    toggleTheme();
    // Redraw chart with new theme colors
    setTimeout(drawTimeseriesChart, 50);
  });

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent'),
    ]);

    // Hide loading, show content
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Render
    renderSummary(summary);
    timeseriesData = timeseries;
    renderCategories(categories);
    renderRecentItems(recent);

    // Draw chart after DOM settles
    requestAnimationFrame(() => {
      drawTimeseriesChart();
    });

    // Resize listener
    window.addEventListener('resize', onResize);
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    contentEl.style.display = 'none';
  }
}

// Start
document.addEventListener('DOMContentLoaded', init);
