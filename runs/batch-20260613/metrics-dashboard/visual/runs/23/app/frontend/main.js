// ===== API Base URL =====
const API_BASE = '/api';

// ===== DOM Elements =====
const loadingState = document.getElementById('loading-state');
const errorState = document.getElementById('error-state');
const dashboardContent = document.getElementById('dashboard-content');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = themeToggle.querySelector('.theme-icon');
const retryBtn = document.getElementById('retry-btn');

// ===== State =====
let currentTheme = 'light';
let timeseriesData = [];

// ===== Theme =====
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  // Re-render chart with new theme colors
  if (timeseriesData.length > 0) {
    renderChart();
  }
}

async function fetchTheme() {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    applyTheme(data.theme || 'light');
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme }),
    });
  } catch {
    // Optimistic UI update already applied
  }
}

themeToggle.addEventListener('click', toggleTheme);

// ===== Data Fetching =====
async function fetchJSON(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadDashboard() {
  loadingState.style.display = 'flex';
  errorState.style.display = 'none';
  dashboardContent.style.display = 'none';

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent'),
    ]);

    renderSummary(summary);
    timeseriesData = timeseries;
    renderCategories(categories);
    renderRecentItems(recent);

    // Show the content first so containers have dimensions, then draw chart
    loadingState.style.display = 'none';
    dashboardContent.style.display = 'block';

    // Use requestAnimationFrame to ensure layout is computed before drawing
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        renderChart();
      });
    });
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    loadingState.style.display = 'none';
    errorState.style.display = 'flex';
  }
}

retryBtn.addEventListener('click', loadDashboard);

// ===== Format Helpers =====
function formatNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(isoStr) {
  // Parse ISO date string and format nicely
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Render Summary Cards =====
function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('stat-visitors-sub').textContent = '30-day total';

  document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('stat-revenue-sub').textContent = '30-day total';

  document.getElementById('stat-bestday').textContent = formatNumber(data.bestDay.visitors);
  document.getElementById('stat-bestday-sub').textContent = formatDate(data.bestDay.date);

  const trendEl = document.getElementById('stat-trend');
  const sign = data.trend7d >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${data.trend7d}%`;
  trendEl.classList.remove('trend-up', 'trend-down');
  trendEl.classList.add(data.trend7d >= 0 ? 'trend-up' : 'trend-down');
}

// ===== Render Chart Helper =====
function renderChart() {
  const wrapper = document.getElementById('timeseries-wrapper');
  // Always recreate the container div for the chart
  wrapper.innerHTML = '<div id="timeseries-chart" style="width:100%;height:100%;"></div>';
  drawTimeseries(timeseriesData);
}

// ===== Draw Time-series SVG Chart =====
function drawTimeseries(data) {
  if (!data || data.length === 0) return;

  const container = document.getElementById('timeseries-chart');
  const rect = container.getBoundingClientRect();
  const W = Math.floor(rect.width);
  const H = Math.floor(rect.height);

  if (W <= 0 || H <= 0) return;

  // Get current CSS custom properties for theming
  const styles = getComputedStyle(document.documentElement);
  const gridColor = styles.getPropertyValue('--chart-grid').trim();
  const axisColor = styles.getPropertyValue('--chart-axis').trim();
  const lineColor = styles.getPropertyValue('--chart-line').trim();
  const fillColor = styles.getPropertyValue('--chart-fill').trim();
  const bgCardColor = styles.getPropertyValue('--bg-card').trim();

  // Margins — adaptive for narrow screens
  const isNarrow = W < 400;
  const margin = {
    top: 16,
    right: isNarrow ? 8 : 16,
    bottom: 44,
    left: isNarrow ? 44 : 56
  };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Data
  const visitors = data.map(d => parseInt(d.visitors, 10));
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const rangeV = maxV - minV || 1;
  const padV = rangeV * 0.1;
  const yMin = Math.max(0, Math.floor(minV - padV));
  const yMax = Math.ceil(maxV + padV);

  // Scales
  const xScale = (i) => margin.left + (i / (data.length - 1)) * plotW;
  const yScale = (v) => margin.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Build SVG
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">`);

  // Y-axis gridlines and labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(val);
    parts.push(`<line x1="${margin.left}" y1="${y}" x2="${W - margin.right}" y2="${y}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="4,3" />`);
    // Format y label
    let label;
    const rounded = Math.round(val);
    if (rounded >= 1000) {
      label = (rounded / 1000).toFixed(1) + 'k';
    } else {
      label = rounded.toString();
    }
    parts.push(`<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="${isNarrow ? 9 : 11}" font-family="sans-serif" fill="${axisColor}">${label}</text>`);
  }

  // X-axis labels — show fewer on narrow screens, avoid overlap
  const maxLabels = isNarrow ? 4 : W < 600 ? 6 : 8;
  const labelInterval = Math.max(1, Math.ceil(data.length / maxLabels));
  // Compute which indices to label (evenly spaced, skip last if too close)
  const labelIndices = [];
  for (let i = 0; i < data.length; i++) {
    if (i % labelInterval === 0) {
      labelIndices.push(i);
    }
  }
  // Add the last point only if it's far enough from the previous label
  const lastIdx = data.length - 1;
  if (labelIndices.length > 0 && labelIndices[labelIndices.length - 1] !== lastIdx) {
    const prevLabelIdx = labelIndices[labelIndices.length - 1];
    const minPixelGap = isNarrow ? 30 : 40;
    if (xScale(lastIdx) - xScale(prevLabelIdx) >= minPixelGap) {
      labelIndices.push(lastIdx);
    }
  }

  for (const i of labelIndices) {
    const x = xScale(i);
    const dateStr = data[i].date;
    // Handle ISO date: "2025-01-14T00:00:00.000Z" or "2025-01-14"
    const cleanDate = dateStr.split('T')[0];
    const dateParts = cleanDate.split('-');
    const label = `${parseInt(dateParts[1])}/${parseInt(dateParts[2])}`;
    parts.push(`<text x="${x}" y="${H - margin.bottom + 18}" text-anchor="middle" font-size="${isNarrow ? 9 : 11}" font-family="sans-serif" fill="${axisColor}">${label}</text>`);
    // Subtle vertical gridline
    parts.push(`<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotH}" stroke="${gridColor}" stroke-width="0.5" stroke-dasharray="2,4" />`);
  }

  // Area fill under curve
  let areaPath = `M ${xScale(0).toFixed(1)} ${yScale(visitors[0]).toFixed(1)}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xScale(i).toFixed(1)} ${yScale(visitors[i]).toFixed(1)}`;
  }
  areaPath += ` L ${xScale(data.length - 1).toFixed(1)} ${(margin.top + plotH).toFixed(1)} L ${xScale(0).toFixed(1)} ${(margin.top + plotH).toFixed(1)} Z`;
  parts.push(`<path d="${areaPath}" fill="${fillColor}" />`);

  // Line
  let linePath = `M ${xScale(0).toFixed(1)} ${yScale(visitors[0]).toFixed(1)}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xScale(i).toFixed(1)} ${yScale(visitors[i]).toFixed(1)}`;
  }
  parts.push(`<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`);

  // Data point dots — skip on very narrow screens to avoid clutter
  if (!isNarrow) {
    for (let i = 0; i < data.length; i++) {
      const cx = xScale(i).toFixed(1);
      const cy = yScale(visitors[i]).toFixed(1);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${lineColor}" stroke="${bgCardColor}" stroke-width="1.5" />`);
    }
  }

  // Axes lines
  parts.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1" />`);
  parts.push(`<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${W - margin.right}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1" />`);

  parts.push('</svg>');

  container.innerHTML = parts.join('');
}

// ===== Render Categories =====
function renderCategories(data) {
  const container = document.getElementById('categories-list');
  const maxValue = Math.max(...data.map(d => parseInt(d.value, 10)));

  let html = '';
  for (const cat of data) {
    const value = parseInt(cat.value, 10);
    const pct = (value / maxValue) * 100;
    html += `
      <div class="category-item">
        <div class="category-header">
          <span class="category-name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
          <span class="category-value">${formatNumber(value)}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>`;
  }
  container.innerHTML = html;
}

// ===== Render Recent Items Table =====
function renderRecentItems(data) {
  const tbody = document.getElementById('recent-tbody');
  let html = '';
  for (const item of data) {
    const dateStr = formatDate(item.created_at);
    html += `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td class="cell-category" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
        <td>${formatCurrency(parseFloat(item.value))}</td>
        <td>${dateStr}</td>
      </tr>`;
  }
  tbody.innerHTML = html;
}

// ===== Resize Handler =====
let resizeTimer;
function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (timeseriesData.length > 0) {
      renderChart();
    }
  }, 150);
}

window.addEventListener('resize', handleResize);

// ===== Initialize =====
async function init() {
  // Fetch and apply theme before loading data (prevents flash of wrong theme)
  await fetchTheme();
  loadDashboard();
}

init();
