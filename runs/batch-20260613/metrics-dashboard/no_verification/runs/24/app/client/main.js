// ========================================
// Configuration
// ========================================
const API_BASE = '/api';

// ========================================
// State
// ========================================
let currentTheme = 'light';
let timeseriesData = [];

// ========================================
// API helpers
// ========================================
async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ========================================
// Theme
// ========================================
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
  // Redraw chart with new colors
  if (timeseriesData.length > 0) {
    drawChart(timeseriesData);
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
}

// ========================================
// Number formatting
// ========================================
function formatNumber(n) {
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ========================================
// Render: Stat Cards
// ========================================
function renderStatCards(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('stat-bestday').textContent = formatNumber(summary.bestDay.visitors) + ' visitors';
  document.getElementById('stat-bestday-date').textContent = formatDate(summary.bestDay.date);

  const trendEl = document.getElementById('stat-trend');
  const indicatorEl = document.getElementById('trend-indicator');
  const trendVal = summary.trendPct;
  const sign = trendVal >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${trendVal}%`;

  if (trendVal > 0) {
    indicatorEl.textContent = '▲ Trending Up';
    indicatorEl.className = 'stat-sub trend-indicator positive';
  } else if (trendVal < 0) {
    indicatorEl.textContent = '▼ Trending Down';
    indicatorEl.className = 'stat-sub trend-indicator negative';
  } else {
    indicatorEl.textContent = '— Flat';
    indicatorEl.className = 'stat-sub trend-indicator';
  }
}

// ========================================
// Render: Time-Series Chart (SVG)
// ========================================
function drawChart(data) {
  timeseriesData = data;
  const container = document.getElementById('chart-container');
  const svg = document.getElementById('timeseries-chart');

  const rect = container.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  if (width <= 0 || height <= 0) return;

  // Get current theme CSS variables
  const style = getComputedStyle(document.documentElement);
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const fillColor = style.getPropertyValue('--chart-fill').trim();
  const textColor = style.getPropertyValue('--text-secondary').trim();

  // Margins
  const margin = {
    top: 20,
    right: 20,
    bottom: 44,
    left: width < 500 ? 48 : 60,
  };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  if (innerW <= 0 || innerH <= 0) return;

  // Data bounds
  const values = data.map(d => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const valRange = maxVal - minVal || 1;
  const yPadding = valRange * 0.1;
  const yMin = Math.max(0, minVal - yPadding);
  const yMax = maxVal + yPadding;

  // Scale functions
  const xScale = (i) => margin.left + (i / (data.length - 1)) * innerW;
  const yScale = (v) => margin.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Build SVG content
  let svgContent = '';

  // Y-axis gridlines and labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(val);
    // Gridline
    svgContent += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="4,3" />`;
    // Label
    const label = val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val).toString();
    svgContent += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="${textColor}" font-size="11" font-family="inherit">${label}</text>`;
  }

  // X-axis labels
  const xLabelCount = width < 500 ? 5 : width < 800 ? 8 : 10;
  const step = Math.max(1, Math.floor(data.length / xLabelCount));
  for (let i = 0; i < data.length; i += step) {
    const x = xScale(i);
    const dateStr = data[i].date;
    const label = formatDate(dateStr);
    svgContent += `<text x="${x}" y="${height - margin.bottom + 20}" text-anchor="middle" fill="${textColor}" font-size="11" font-family="inherit">${label}</text>`;
    // Tick mark
    svgContent += `<line x1="${x}" y1="${margin.top + innerH}" x2="${x}" y2="${margin.top + innerH + 5}" stroke="${axisColor}" stroke-width="1" />`;
  }

  // Axes
  svgContent += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}" stroke="${axisColor}" stroke-width="1.5" />`;
  svgContent += `<line x1="${margin.left}" y1="${margin.top + innerH}" x2="${width - margin.right}" y2="${margin.top + innerH}" stroke="${axisColor}" stroke-width="1.5" />`;

  // Area fill
  let areaPath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }
  areaPath += ` L ${xScale(data.length - 1)} ${margin.top + innerH}`;
  areaPath += ` L ${xScale(0)} ${margin.top + innerH} Z`;
  svgContent += `<path d="${areaPath}" fill="${fillColor}" />`;

  // Line
  let linePath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }
  svgContent += `<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;

  // Data points
  for (let i = 0; i < data.length; i++) {
    const cx = xScale(i);
    const cy = yScale(data[i].visitors);
    svgContent += `<circle cx="${cx}" cy="${cy}" r="3" fill="${lineColor}" stroke="var(--bg-card)" stroke-width="1.5" />`;
  }

  // Set SVG attributes and content
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = svgContent;
}

// ========================================
// Render: Category Breakdown
// ========================================
function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  const maxVal = Math.max(...categories.map(c => c.value));

  container.innerHTML = categories.map(cat => {
    const pct = (cat.value / maxVal * 100).toFixed(1);
    const formattedVal = formatNumber(cat.value);
    return `
      <div class="category-row">
        <div class="category-header">
          <span class="category-name" title="${cat.name}">${cat.name}</span>
          <span class="category-value">${formattedVal}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ========================================
// Render: Recent Items Table
// ========================================
function renderRecentItems(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = items.map(item => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${formatCurrency(item.value)}</td>
      <td>${formatDateTime(item.createdAt)}</td>
    </tr>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========================================
// Resize handler for chart
// ========================================
let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (timeseriesData.length > 0) {
      drawChart(timeseriesData);
    }
  }, 100);
}

// ========================================
// Main initialization
// ========================================
async function init() {
  const errorOverlay = document.getElementById('error-overlay');
  const mainContent = document.querySelector('.dashboard-grid');

  try {
    // Load theme first for immediate application
    const settings = await apiFetch('/settings');
    applyTheme(settings.theme || 'light');

    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/summary'),
      apiFetch('/timeseries'),
      apiFetch('/categories'),
      apiFetch('/recent'),
    ]);

    // Render everything
    renderStatCards(summary);
    renderCategories(categories);
    renderRecentItems(recent);

    // Draw chart after a frame to ensure container is sized
    requestAnimationFrame(() => {
      drawChart(timeseries);
    });

    // Show content, hide error
    errorOverlay.style.display = 'none';
    mainContent.style.display = '';

  } catch (err) {
    console.error('Failed to load dashboard:', err);
    errorOverlay.style.display = 'flex';
    mainContent.style.display = 'none';
  }
}

// ========================================
// Event Listeners
// ========================================
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
document.getElementById('retry-btn').addEventListener('click', init);
window.addEventListener('resize', handleResize);

// Also observe container resize for more robust chart redraw
if (typeof ResizeObserver !== 'undefined') {
  const chartContainer = document.getElementById('chart-container');
  const ro = new ResizeObserver(() => {
    handleResize();
  });
  ro.observe(chartContainer);
}

// Start
init();
