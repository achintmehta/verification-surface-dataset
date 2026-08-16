const API_BASE = '/api';

// ===== State =====
let currentTheme = 'light';
let timeseriesData = [];

// ===== Utility =====
function formatNumber(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function formatCurrency(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '—';
  let date;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    date = new Date(y, m - 1, day);
  } else {
    date = d instanceof Date ? d : new Date(d);
  }
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatFullDate(d) {
  if (!d) return '—';
  // If it's a date-only string like "2025-01-29", parse without timezone shift
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    const date = new Date(y, m - 1, day);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function showError() {
  document.getElementById('error-banner').classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

// ===== API =====
async function fetchJSON(endpoint) {
  const res = await fetch(API_BASE + endpoint);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ===== Theme =====
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon-text');
  if (icon) icon.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

async function loadTheme() {
  // Allow URL override for testing: ?theme=dark or ?theme=light
  const urlParams = new URLSearchParams(window.location.search);
  const urlTheme = urlParams.get('theme');
  if (urlTheme === 'dark' || urlTheme === 'light') {
    applyTheme(urlTheme);
    // Also persist it
    try {
      await fetch(API_BASE + '/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: urlTheme }),
      });
    } catch {}
    return;
  }
  try {
    const data = await fetchJSON('/settings');
    applyTheme(data.theme || 'light');
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  // Redraw chart for new colors
  drawChart();
  try {
    await fetch(API_BASE + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme }),
    });
  } catch {
    // Theme applied locally even if save fails
  }
}

// ===== Stat Cards =====
async function loadSummary() {
  try {
    const data = await fetchJSON('/summary');

    document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
    document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);

    const bestDate = data.bestDay?.date;
    document.getElementById('stat-bestday').textContent = formatNumber(data.bestDay?.visitors);
    document.getElementById('stat-bestday-sub').textContent = bestDate ? formatFullDate(bestDate) : '';

    const trend = data.trend7d;
    const trendEl = document.getElementById('stat-trend');
    const trendSubEl = document.getElementById('stat-trend-sub');
    const isPositive = trend >= 0;
    trendEl.textContent = (isPositive ? '+' : '') + trend + '%';
    trendEl.style.color = isPositive ? 'var(--success)' : 'var(--danger)';
    trendSubEl.textContent = 'vs previous 7 days';
    trendSubEl.className = 'stat-sub ' + (isPositive ? 'positive' : 'negative');
    return true;
  } catch (e) {
    console.error('loadSummary failed:', e);
    return false;
  }
}

// ===== Time Series Chart (SVG) =====
function getChartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue('--chart-grid').trim() || '#e0e0e8',
    axis: style.getPropertyValue('--chart-axis').trim() || '#555770',
    line: style.getPropertyValue('--chart-line').trim() || '#4361ee',
    dot: style.getPropertyValue('--chart-dot').trim() || '#4361ee',
    area: style.getPropertyValue('--chart-area').trim() || 'rgba(67, 97, 238, 0.1)',
    textPrimary: style.getPropertyValue('--text-primary').trim() || '#1a1a2e',
    textSecondary: style.getPropertyValue('--text-secondary').trim() || '#555770',
    textMuted: style.getPropertyValue('--text-muted').trim() || '#8b8da3',
  };
}

function drawChart() {
  if (!timeseriesData || timeseriesData.length === 0) return;

  const container = document.getElementById('chart-container');
  const svg = document.getElementById('timeseries-chart');
  const rect = container.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);

  if (width <= 0 || height <= 0) return;

  const colors = getChartColors();

  // Margins - adjust for small screens
  const isSmall = width < 400;
  const margin = {
    top: 20,
    right: 15,
    bottom: 45,
    left: isSmall ? 45 : 55,
  };

  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Data
  const visitors = timeseriesData.map(d => Number(d.visitors));
  const dates = timeseriesData.map(d => {
    const str = String(d.date);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [y, m, day] = str.split('-').map(Number);
      return new Date(y, m - 1, day);
    }
    return new Date(str);
  });
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const rangeV = maxV - minV || 1;
  const padding = rangeV * 0.1;
  const yMin = Math.max(0, minV - padding);
  const yMax = maxV + padding;
  const yRange = yMax - yMin;

  // Scale functions
  const xScale = (i) => margin.left + (i / (visitors.length - 1)) * plotW;
  const yScale = (v) => margin.top + plotH - ((v - yMin) / yRange) * plotH;

  // Build SVG
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = '';

  const ns = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) {
      e.setAttribute(k, v);
    }
    return e;
  }

  // Gridlines (horizontal)
  const numGridlines = 5;
  for (let i = 0; i <= numGridlines; i++) {
    const v = yMin + (yRange * i) / numGridlines;
    const y = yScale(v);
    svg.appendChild(el('line', {
      x1: margin.left, y1: y,
      x2: width - margin.right, y2: y,
      stroke: colors.grid, 'stroke-width': 1, 'stroke-dasharray': '3,3'
    }));

    // Y-axis labels
    const label = el('text', {
      x: margin.left - 8, y: y + 4,
      fill: colors.axis, 'font-size': isSmall ? '10' : '11', 'text-anchor': 'end',
      'font-family': '-apple-system, BlinkMacSystemFont, sans-serif'
    });
    const roundedV = Math.round(v);
    label.textContent = roundedV >= 1000 ? (roundedV / 1000).toFixed(1) + 'k' : roundedV.toString();
    svg.appendChild(label);
  }

  // Area fill
  let areaPath = `M ${xScale(0)} ${yScale(visitors[0])}`;
  for (let i = 1; i < visitors.length; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
  }
  areaPath += ` L ${xScale(visitors.length - 1)} ${margin.top + plotH}`;
  areaPath += ` L ${xScale(0)} ${margin.top + plotH} Z`;
  svg.appendChild(el('path', {
    d: areaPath, fill: colors.area, stroke: 'none'
  }));

  // Line
  let linePath = `M ${xScale(0)} ${yScale(visitors[0])}`;
  for (let i = 1; i < visitors.length; i++) {
    linePath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
  }
  svg.appendChild(el('path', {
    d: linePath, fill: 'none', stroke: colors.line, 'stroke-width': 2.5,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round'
  }));

  // Dots
  const dotRadius = visitors.length > 60 ? 1.5 : (isSmall ? 2 : 3);
  for (let i = 0; i < visitors.length; i++) {
    svg.appendChild(el('circle', {
      cx: xScale(i), cy: yScale(visitors[i]),
      r: dotRadius,
      fill: colors.dot, stroke: 'none'
    }));
  }

  // X-axis labels (show subset to avoid overlap)
  const maxXLabels = Math.max(2, Math.floor(plotW / 65));
  const step = Math.max(1, Math.ceil(dates.length / maxXLabels));
  for (let i = 0; i < dates.length; i += step) {
    const x = xScale(i);
    const label = el('text', {
      x: x, y: margin.top + plotH + 20,
      fill: colors.axis, 'font-size': isSmall ? '9' : '11', 'text-anchor': 'middle',
      'font-family': '-apple-system, BlinkMacSystemFont, sans-serif'
    });
    label.textContent = formatDate(dates[i]);
    svg.appendChild(label);

    // Tick mark
    svg.appendChild(el('line', {
      x1: x, y1: margin.top + plotH,
      x2: x, y2: margin.top + plotH + 5,
      stroke: colors.axis, 'stroke-width': 1
    }));
  }

  // Axes
  svg.appendChild(el('line', {
    x1: margin.left, y1: margin.top + plotH,
    x2: width - margin.right, y2: margin.top + plotH,
    stroke: colors.axis, 'stroke-width': 1
  }));
  svg.appendChild(el('line', {
    x1: margin.left, y1: margin.top,
    x2: margin.left, y2: margin.top + plotH,
    stroke: colors.axis, 'stroke-width': 1
  }));
}

async function loadTimeseries() {
  try {
    timeseriesData = await fetchJSON('/timeseries');
    drawChart();
    return true;
  } catch (e) {
    console.error('loadTimeseries failed:', e);
    return false;
  }
}

// ===== Categories =====
async function loadCategories() {
  try {
    const data = await fetchJSON('/categories');
    const list = document.getElementById('categories-list');
    list.innerHTML = '';

    const maxVal = Math.max(...data.map(d => Number(d.value)));

    for (const cat of data) {
      const val = Number(cat.value);
      const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;

      const item = document.createElement('div');
      item.className = 'category-item';

      const header = document.createElement('div');
      header.className = 'category-header';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'category-name';
      nameSpan.textContent = cat.name;
      nameSpan.title = cat.name;

      const valueSpan = document.createElement('span');
      valueSpan.className = 'category-value';
      valueSpan.textContent = formatNumber(val);

      header.appendChild(nameSpan);
      header.appendChild(valueSpan);

      const barBg = document.createElement('div');
      barBg.className = 'category-bar-bg';

      const barFill = document.createElement('div');
      barFill.className = 'category-bar-fill';
      barFill.style.width = pct + '%';

      barBg.appendChild(barFill);

      item.appendChild(header);
      item.appendChild(barBg);
      list.appendChild(item);
    }
    return true;
  } catch (e) {
    console.error('loadCategories failed:', e);
    return false;
  }
}

// ===== Recent Items Table =====
async function loadRecentItems() {
  try {
    const data = await fetchJSON('/recent');
    const tbody = document.getElementById('recent-tbody');
    tbody.innerHTML = '';

    for (const item of data) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = item.name;
      tdName.title = item.name;

      const tdCat = document.createElement('td');
      tdCat.textContent = item.category;
      tdCat.title = item.category;

      const tdVal = document.createElement('td');
      tdVal.textContent = formatCurrency(Number(item.value));

      const tdDate = document.createElement('td');
      tdDate.textContent = formatFullDate(item.created_at);

      tr.appendChild(tdName);
      tr.appendChild(tdCat);
      tr.appendChild(tdVal);
      tr.appendChild(tdDate);
      tbody.appendChild(tr);
    }
    return true;
  } catch (e) {
    console.error('loadRecentItems failed:', e);
    return false;
  }
}

// ===== Resize Handling =====
let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    drawChart();
  }, 100);
}

// ===== Init =====
async function init() {
  // Load theme first (before first paint of data)
  await loadTheme();

  // Set up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Load all data
  const results = await Promise.all([
    loadSummary(),
    loadTimeseries(),
    loadCategories(),
    loadRecentItems(),
  ]);

  // Show error if all failed
  const allFailed = results.every(r => r === false);
  if (allFailed) {
    showError();
  } else {
    hideError();
  }

  // Resize listener
  window.addEventListener('resize', handleResize);

  // ResizeObserver on chart container for accurate redraw
  const chartContainer = document.getElementById('chart-container');
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      handleResize();
    });
    ro.observe(chartContainer);
  }

  // Watch for theme attribute changes to redraw chart
  const observer = new MutationObserver(() => {
    setTimeout(drawChart, 50);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

init();
