// ============================================
// API Module
// ============================================
const API_BASE = '/api';

async function apiFetch(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function apiPut(endpoint, body) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// ============================================
// Theme Module
// ============================================
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

async function loadTheme() {
  try {
    const settings = await apiFetch('/settings');
    applyTheme(settings.theme || 'light');
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await apiPut('/settings', { theme: newTheme });
  } catch (e) {
    console.error('Failed to persist theme:', e);
  }
  // Redraw chart with new theme colors
  if (window._timeseriesData) {
    drawTimeseriesChart(window._timeseriesData);
  }
}

// ============================================
// Formatting Utilities
// ============================================
function formatNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  // Handle date-only strings (YYYY-MM-DD) to avoid timezone issues
  const str = String(dateStr);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  // For date-only that might come with T00:00:00 etc, extract just the date part
  const datePart = str.split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const [y, m, d] = datePart.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  const dt = new Date(str);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// ============================================
// Summary Cards
// ============================================
function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('stat-visitors-sub').textContent = '30-day total';

  document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('stat-revenue-sub').textContent = '30-day total';

  document.getElementById('stat-bestday').textContent = formatNumber(data.bestDay.visitors);
  document.getElementById('stat-bestday-sub').textContent = formatDate(data.bestDay.date);

  const trendEl = document.getElementById('stat-trend');
  const trendValue = data.weeklyTrend;
  const trendSign = trendValue >= 0 ? '+' : '';
  trendEl.textContent = `${trendSign}${trendValue}%`;
  trendEl.classList.remove('trend-up', 'trend-down');
  trendEl.classList.add(trendValue >= 0 ? 'trend-up' : 'trend-down');
}

// ============================================
// Time-series SVG Chart
// ============================================
function drawTimeseriesChart(data) {
  window._timeseriesData = data;

  const wrapper = document.getElementById('timeseries-wrapper');
  const svg = document.getElementById('timeseries-chart');
  
  const containerWidth = wrapper.clientWidth;
  if (containerWidth <= 0) return;

  // Dimensions
  const width = containerWidth;
  const height = Math.min(Math.max(200, containerWidth * 0.5), 350);
  const margin = { top: 20, right: 16, bottom: 44, left: 52 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Get theme-aware colors from CSS
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const fillColor = style.getPropertyValue('--chart-fill').trim();
  const dotColor = style.getPropertyValue('--chart-dot').trim();

  // Data bounds
  const visitors = data.map(d => parseInt(d.visitors));
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const yPad = (maxV - minV) * 0.1 || 100;
  const yMin = Math.max(0, Math.floor((minV - yPad) / 100) * 100);
  const yMax = Math.ceil((maxV + yPad) / 100) * 100;

  // Scales
  const xScale = (i) => margin.left + (i / (data.length - 1)) * plotW;
  const yScale = (v) => margin.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Build SVG content
  let svgContent = '';

  // Y-axis gridlines and labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(val);
    svgContent += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="4,4"/>`;
    svgContent += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="${axisColor}" font-size="10" font-family="sans-serif">${Math.round(val).toLocaleString()}</text>`;
  }

  // X-axis labels (show a subset to avoid overlapping)
  const labelInterval = width < 500 ? 7 : width < 700 ? 5 : 3;
  for (let i = 0; i < data.length; i++) {
    if (i % labelInterval === 0 || i === data.length - 1) {
      const x = xScale(i);
      const label = formatDate(data[i].date);
      svgContent += `<text x="${x}" y="${height - margin.bottom + 20}" text-anchor="middle" fill="${axisColor}" font-size="10" font-family="sans-serif">${label}</text>`;
      svgContent += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotH}" stroke="${gridColor}" stroke-width="0.5" stroke-dasharray="2,4"/>`;
    }
  }

  // Axis lines
  svgContent += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1"/>`;
  svgContent += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1"/>`;

  // Area fill
  let areaPath = `M ${xScale(0)} ${yScale(visitors[0])}`;
  for (let i = 1; i < visitors.length; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
  }
  areaPath += ` L ${xScale(visitors.length - 1)} ${margin.top + plotH}`;
  areaPath += ` L ${xScale(0)} ${margin.top + plotH} Z`;
  svgContent += `<path d="${areaPath}" fill="${fillColor}"/>`;

  // Line
  let linePath = `M ${xScale(0)} ${yScale(visitors[0])}`;
  for (let i = 1; i < visitors.length; i++) {
    linePath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
  }
  svgContent += `<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Dots
  for (let i = 0; i < visitors.length; i++) {
    const cx = xScale(i);
    const cy = yScale(visitors[i]);
    svgContent += `<circle cx="${cx}" cy="${cy}" r="3" fill="${dotColor}" stroke="white" stroke-width="1"/>`;
  }

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = svgContent;
}

// ============================================
// Category Breakdown
// ============================================
function renderCategories(data) {
  const container = document.getElementById('categories-list');
  const maxValue = Math.max(...data.map(d => parseInt(d.value)));

  container.innerHTML = data.map(cat => {
    const pct = (parseInt(cat.value) / maxValue) * 100;
    return `
      <div class="category-item">
        <div class="category-header">
          <span class="category-name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
          <span class="category-value">${formatNumber(parseInt(cat.value))}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================
// Recent Items Table
// ============================================
function renderRecentItems(data) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = data.map(item => {
    return `
      <tr>
        <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
        <td title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
        <td>${formatCurrency(parseFloat(item.value))}</td>
        <td>${formatDateTime(item.created_at)}</td>
      </tr>
    `;
  }).join('');
}

// ============================================
// Dashboard Initialization
// ============================================
function showLoading() {
  document.getElementById('loading-state').style.display = 'flex';
  document.getElementById('error-state').style.display = 'none';
  document.getElementById('dashboard-content').style.display = 'none';
}

function showError() {
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('error-state').style.display = 'flex';
  document.getElementById('dashboard-content').style.display = 'none';
}

function showDashboard() {
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('error-state').style.display = 'none';
  document.getElementById('dashboard-content').style.display = 'flex';
}

async function loadDashboard() {
  showLoading();

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/summary'),
      apiFetch('/timeseries'),
      apiFetch('/categories'),
      apiFetch('/recent')
    ]);

    renderSummary(summary);
    renderCategories(categories);
    renderRecentItems(recent);
    showDashboard();

    // Draw chart after DOM is visible
    requestAnimationFrame(() => {
      drawTimeseriesChart(timeseries);
    });
  } catch (e) {
    console.error('Failed to load dashboard:', e);
    showError();
  }
}

// ============================================
// Resize handling
// ============================================
let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (window._timeseriesData) {
      drawTimeseriesChart(window._timeseriesData);
    }
  }, 150);
}

function setupResizeObserver() {
  const wrapper = document.getElementById('timeseries-wrapper');
  if (!wrapper) return;
  
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      handleResize();
    });
    observer.observe(wrapper);
  }
}

// ============================================
// Init
// ============================================
async function init() {
  // Load theme first (before painting dashboard)
  await loadTheme();

  // Set up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Set up retry button
  document.getElementById('retry-btn').addEventListener('click', loadDashboard);

  // Listen for resize
  window.addEventListener('resize', handleResize);

  // Setup ResizeObserver for chart container
  setupResizeObserver();

  // Load dashboard data
  await loadDashboard();
}

// Start
init();
