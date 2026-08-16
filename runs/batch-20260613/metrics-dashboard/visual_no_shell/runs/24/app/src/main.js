// ==============================
// API Helpers
// ==============================
const API_BASE = '/api';

async function fetchJSON(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function putJSON(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ==============================
// Theme Management
// ==============================
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
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
  // Re-render chart with new theme colors
  setTimeout(() => renderTimeseriesChart(), 50);
  try {
    await putJSON('/settings', { theme: newTheme });
  } catch (err) {
    console.error('Failed to persist theme:', err);
  }
}

// ==============================
// Format Helpers
// ==============================
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
  // Parse as UTC to avoid timezone shifts
  const parts = String(dateStr).split('T')[0].split('-');
  if (parts.length === 3) {
    const d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// ==============================
// Stat Cards
// ==============================
function renderStatCards(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  
  if (summary.bestDay) {
    document.getElementById('stat-bestday').textContent = formatCurrency(summary.bestDay.revenue);
    document.getElementById('stat-bestday-sub').textContent = formatDate(summary.bestDay.date);
  }

  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trendPercent;
  const sign = trendVal >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${trendVal}%`;
  trendEl.className = 'stat-value ' + (trendVal >= 0 ? 'trend-up' : 'trend-down');
}

// ==============================
// SVG Time-Series Chart
// ==============================
let timeseriesData = null;

function renderTimeseriesChart() {
  if (!timeseriesData || timeseriesData.length === 0) return;

  const svg = document.getElementById('timeseries-chart');
  const wrapper = document.getElementById('timeseries-wrapper');
  const wrapperWidth = wrapper.clientWidth;
  
  if (wrapperWidth <= 0) return;

  const data = timeseriesData;
  const isNarrow = wrapperWidth < 500;
  const margin = { top: 20, right: 20, bottom: 50, left: isNarrow ? 55 : 65 };
  const width = wrapperWidth;
  const height = 300;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  // Get computed style for theme colors
  const styles = getComputedStyle(document.documentElement);
  const gridColor = styles.getPropertyValue('--chart-grid').trim();
  const axisColor = styles.getPropertyValue('--chart-axis').trim();
  const lineColor = styles.getPropertyValue('--chart-line').trim();
  const fillColor = styles.getPropertyValue('--chart-fill').trim();
  const dotColor = styles.getPropertyValue('--chart-dot').trim();
  const bgColor = styles.getPropertyValue('--bg-card').trim();

  // Parse data
  const revenues = data.map(d => parseFloat(d.revenue));
  const minRev = Math.min(...revenues);
  const maxRev = Math.max(...revenues);
  const revRange = maxRev - minRev || 1;
  const yPadding = revRange * 0.1;
  const yMin = Math.max(0, minRev - yPadding);
  const yMax = maxRev + yPadding;

  function xPos(i) {
    return margin.left + (i / (data.length - 1)) * innerWidth;
  }

  function yPos(val) {
    return margin.top + innerHeight - ((val - yMin) / (yMax - yMin)) * innerHeight;
  }

  // Build SVG
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = '';

  // Background
  const bg = createSVGEl('rect', { x: 0, y: 0, width, height, fill: bgColor, rx: 8 });
  svg.appendChild(bg);

  // Y-axis gridlines & labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yPos(val);

    // Gridline
    const line = createSVGEl('line', {
      x1: margin.left, y1: y,
      x2: width - margin.right, y2: y,
      stroke: gridColor, 'stroke-width': 1, 'stroke-dasharray': '3,3'
    });
    svg.appendChild(line);

    // Label
    const label = createSVGEl('text', {
      x: margin.left - 8, y: y + 4,
      'text-anchor': 'end',
      fill: axisColor,
      'font-size': isNarrow ? '10' : '11',
      'font-family': 'inherit'
    });
    label.textContent = '$' + Math.round(val).toLocaleString('en-US');
    svg.appendChild(label);
  }

  // X-axis labels
  const xLabelCount = isNarrow ? 5 : Math.min(data.length, 10);
  const step = Math.max(1, Math.floor((data.length - 1) / (xLabelCount - 1)));
  for (let i = 0; i < data.length; i += step) {
    const x = xPos(i);
    const dateLabel = formatDate(data[i].date);

    // Tick
    const tick = createSVGEl('line', {
      x1: x, y1: margin.top + innerHeight,
      x2: x, y2: margin.top + innerHeight + 5,
      stroke: axisColor, 'stroke-width': 1
    });
    svg.appendChild(tick);

    // Label
    const label = createSVGEl('text', {
      x, y: margin.top + innerHeight + 20,
      'text-anchor': 'middle',
      fill: axisColor,
      'font-size': isNarrow ? '9' : '11',
      'font-family': 'inherit',
      'transform': isNarrow ? `rotate(-30, ${x}, ${margin.top + innerHeight + 20})` : ''
    });
    label.textContent = dateLabel;
    svg.appendChild(label);
  }

  // Axes lines
  const xAxis = createSVGEl('line', {
    x1: margin.left, y1: margin.top + innerHeight,
    x2: width - margin.right, y2: margin.top + innerHeight,
    stroke: axisColor, 'stroke-width': 1
  });
  svg.appendChild(xAxis);

  const yAxis = createSVGEl('line', {
    x1: margin.left, y1: margin.top,
    x2: margin.left, y2: margin.top + innerHeight,
    stroke: axisColor, 'stroke-width': 1
  });
  svg.appendChild(yAxis);

  // Area fill
  let areaPath = `M ${xPos(0)} ${yPos(revenues[0])}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xPos(i)} ${yPos(revenues[i])}`;
  }
  areaPath += ` L ${xPos(data.length - 1)} ${margin.top + innerHeight}`;
  areaPath += ` L ${xPos(0)} ${margin.top + innerHeight} Z`;

  const area = createSVGEl('path', {
    d: areaPath, fill: fillColor, stroke: 'none'
  });
  svg.appendChild(area);

  // Line
  let linePath = `M ${xPos(0)} ${yPos(revenues[0])}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xPos(i)} ${yPos(revenues[i])}`;
  }
  const lineEl = createSVGEl('path', {
    d: linePath, fill: 'none', stroke: lineColor, 'stroke-width': 2.5, 'stroke-linejoin': 'round'
  });
  svg.appendChild(lineEl);

  // Dots (optionally fewer on narrow)
  const dotStep = isNarrow ? 2 : 1;
  for (let i = 0; i < data.length; i += dotStep) {
    const dot = createSVGEl('circle', {
      cx: xPos(i), cy: yPos(revenues[i]),
      r: isNarrow ? 2.5 : 3.5,
      fill: dotColor, stroke: bgColor, 'stroke-width': 1.5
    });
    svg.appendChild(dot);
  }
}

function createSVGEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

// ==============================
// Categories Breakdown
// ==============================
function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';

  if (!categories || categories.length === 0) return;

  const maxValue = Math.max(...categories.map(c => c.value));

  for (const cat of categories) {
    const item = document.createElement('div');
    item.className = 'category-item';

    const header = document.createElement('div');
    header.className = 'category-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'category-name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name;

    const valueEl = document.createElement('span');
    valueEl.className = 'category-value';
    valueEl.textContent = formatNumber(cat.value);

    header.appendChild(nameEl);
    header.appendChild(valueEl);

    const barBg = document.createElement('div');
    barBg.className = 'category-bar-bg';

    const barFill = document.createElement('div');
    barFill.className = 'category-bar-fill';
    barFill.style.width = `${(cat.value / maxValue) * 100}%`;

    barBg.appendChild(barFill);
    item.appendChild(header);
    item.appendChild(barBg);
    container.appendChild(item);
  }
}

// ==============================
// Recent Items Table
// ==============================
function renderRecentItems(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  for (const item of items) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    tdName.title = item.name;

    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;
    tdCat.title = item.category;

    const tdVal = document.createElement('td');
    tdVal.textContent = formatCurrency(item.value);

    const tdDate = document.createElement('td');
    tdDate.textContent = formatDateTime(item.created_at);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    tbody.appendChild(tr);
  }
}

// ==============================
// Resize Handler
// ==============================
let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderTimeseriesChart();
  }, 100);
}

// ==============================
// Init
// ==============================
async function init() {
  // Load theme first (before data loads)
  await loadTheme();

  // Set up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Load all data
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent'),
    ]);

    // Hide loading, show content
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('dashboard-content').style.display = 'block';

    // Render components
    renderStatCards(summary);

    timeseriesData = timeseries;
    renderTimeseriesChart();

    renderCategories(categories);
    renderRecentItems(recent);

    // Resize listener
    window.addEventListener('resize', onResize);
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('error-state').style.display = 'block';
  }
}

// Start
document.addEventListener('DOMContentLoaded', init);
