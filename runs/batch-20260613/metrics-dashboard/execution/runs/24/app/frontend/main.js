// ──────────────────────────────────────────────────────────────────
// Metrics Dashboard — Vanilla JS entry point
// ──────────────────────────────────────────────────────────────────

const API_BASE = '/api';

// ─── State ─────────────────────────────────────────────────────────
let currentTheme = 'light';
let timeseriesData = [];

// ─── DOM References ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const themeToggle = $('theme-toggle');
const themeIcon = $('theme-icon');
const loadingState = $('loading-state');
const errorState = $('error-state');
const dashboardContent = $('dashboard-content');

// ─── API Helpers ───────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ─── Theme ─────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
  // Redraw chart with new theme colors
  if (timeseriesData.length > 0) {
    drawTimeseriesChart(timeseriesData);
  }
}

themeToggle.addEventListener('click', async () => {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await apiPut('/settings', { theme: newTheme });
  } catch (e) {
    console.error('Failed to persist theme:', e);
  }
});

// ─── Number Formatting ────────────────────────────────────────────
function formatNumber(n) {
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateShort(d) {
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Render Summary Cards ──────────────────────────────────────────
function renderSummary(data) {
  $('val-visitors').textContent = formatNumber(data.totalVisitors);
  $('val-revenue').textContent = formatCurrency(data.totalRevenue);
  $('val-bestday').textContent = formatDate(data.bestDay);

  const trendEl = $('val-trend');
  const indicatorEl = $('trend-indicator');
  const sign = data.trend7d >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${data.trend7d}%`;

  if (data.trend7d >= 0) {
    indicatorEl.textContent = '↑ Up';
    indicatorEl.className = 'trend-indicator up';
  } else {
    indicatorEl.textContent = '↓ Down';
    indicatorEl.className = 'trend-indicator down';
  }
}

// ─── Render Time-Series Chart (Canvas) ─────────────────────────────
function drawTimeseriesChart(data) {
  timeseriesData = data;
  const container = $('timeseries-container');
  const canvas = $('timeseries-canvas');
  const ctx = canvas.getContext('2d');

  // Get theme colors from CSS custom properties
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const dotColor = style.getPropertyValue('--chart-dot').trim();
  const bgColor = style.getPropertyValue('--surface').trim();

  // Size canvas to container
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const width = rect.width;
  const height = Math.max(200, Math.min(width * 0.5, 320));

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.scale(dpr, dpr);

  // Clear
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  if (!data || data.length === 0) return;

  // Responsive margins
  const isNarrow = width < 400;
  const marginLeft = isNarrow ? 45 : 55;
  const marginRight = 12;
  const marginTop = 16;
  const marginBottom = isNarrow ? 36 : 40;
  const chartWidth = width - marginLeft - marginRight;
  const chartHeight = height - marginTop - marginBottom;

  const visitors = data.map(d => d.visitors);
  const minVal = Math.min(...visitors);
  const maxVal = Math.max(...visitors);
  const range = maxVal - minVal || 1;
  const padding = range * 0.1;
  const yMin = Math.max(0, minVal - padding);
  const yMax = maxVal + padding;
  const yRange = yMax - yMin;

  // Scales
  const xScale = (i) => marginLeft + (i / (data.length - 1)) * chartWidth;
  const yScale = (v) => marginTop + chartHeight - ((v - yMin) / yRange) * chartHeight;

  // Grid lines (5 horizontal)
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  const gridCount = 5;
  for (let i = 0; i <= gridCount; i++) {
    const y = marginTop + (i / gridCount) * chartHeight;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(width - marginRight, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Y-axis labels
    const val = yMax - (i / gridCount) * yRange;
    ctx.fillStyle = axisColor;
    ctx.font = (isNarrow ? '9' : '11') + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const label = Math.round(val);
    ctx.fillText(label >= 1000 ? (label / 1000).toFixed(1) + 'k' : label.toString(), marginLeft - 6, y);
  }

  // X-axis labels — show every Nth label to avoid overlap
  const labelWidth = isNarrow ? 35 : 50;
  const maxLabels = Math.floor(chartWidth / labelWidth);
  const labelStep = Math.max(1, Math.ceil(data.length / maxLabels));

  ctx.fillStyle = axisColor;
  ctx.font = (isNarrow ? '8' : '10') + 'px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < data.length; i += labelStep) {
    const x = xScale(i);
    const d = new Date(data[i].date);
    const label = (d.getMonth() + 1) + '/' + d.getDate();
    ctx.fillText(label, x, marginTop + chartHeight + 6);
  }

  // Axes
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + chartHeight);
  ctx.lineTo(width - marginRight, marginTop + chartHeight);
  ctx.stroke();

  // Line
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i].visitors);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill area under line
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = lineColor;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i].visitors);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(xScale(data.length - 1), marginTop + chartHeight);
  ctx.lineTo(xScale(0), marginTop + chartHeight);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // Dots (smaller on narrow screens)
  const dotRadius = isNarrow ? 2 : 3;
  ctx.fillStyle = dotColor;
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i].visitors);
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Render Category Bars ──────────────────────────────────────────
function renderCategories(data) {
  const container = $('categories-container');
  container.innerHTML = '';

  if (!data || data.length === 0) return;

  const maxValue = Math.max(...data.map(c => c.value));

  data.forEach(cat => {
    const pct = (cat.value / maxValue) * 100;

    const row = document.createElement('div');
    row.className = 'category-row';

    const header = document.createElement('div');
    header.className = 'category-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'category-name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name; // full name on hover

    const valEl = document.createElement('span');
    valEl.className = 'category-value';
    valEl.textContent = formatNumber(cat.value);

    header.appendChild(nameEl);
    header.appendChild(valEl);

    const track = document.createElement('div');
    track.className = 'bar-track';

    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = pct + '%';

    track.appendChild(fill);
    row.appendChild(header);
    row.appendChild(track);
    container.appendChild(row);
  });
}

// ─── Render Recent Items Table ─────────────────────────────────────
function renderRecentItems(data) {
  const tbody = $('recent-tbody');
  tbody.innerHTML = '';

  if (!data || data.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No recent items';
    td.style.textAlign = 'center';
    td.style.color = 'var(--text-secondary)';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  data.forEach(item => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;

    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;

    const tdVal = document.createElement('td');
    tdVal.textContent = formatNumber(item.value);

    const tdDate = document.createElement('td');
    tdDate.textContent = formatDate(item.created_at);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);

    tbody.appendChild(tr);
  });
}

// ─── Resize Handling ───────────────────────────────────────────────
// Use ResizeObserver for chart container redraws
let chartResizeObserver = null;

function setupResizeObserver() {
  const container = $('timeseries-container');
  if (!container) return;

  if (chartResizeObserver) {
    chartResizeObserver.disconnect();
  }

  let resizeTimer;
  chartResizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (timeseriesData.length > 0) {
        drawTimeseriesChart(timeseriesData);
      }
    }, 80);
  });

  chartResizeObserver.observe(container);
}

// Also listen for window resize as fallback
let windowResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(windowResizeTimer);
  windowResizeTimer = setTimeout(() => {
    if (timeseriesData.length > 0) {
      drawTimeseriesChart(timeseriesData);
    }
  }, 100);
});

// ─── Initialization ────────────────────────────────────────────────
async function init() {
  try {
    // Load theme first (before other data) to avoid flash
    const settings = await apiFetch('/settings');
    applyTheme(settings.theme || 'light');

    // Load all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/summary'),
      apiFetch('/timeseries'),
      apiFetch('/categories'),
      apiFetch('/recent')
    ]);

    // Hide loading, show content
    loadingState.style.display = 'none';
    dashboardContent.style.display = 'block';

    // Render
    renderSummary(summary);
    drawTimeseriesChart(timeseries);
    renderCategories(categories);
    renderRecentItems(recent);

    // Setup resize observer after initial render
    setupResizeObserver();
  } catch (err) {
    console.error('Dashboard initialization failed:', err);
    loadingState.style.display = 'none';
    errorState.style.display = 'block';
    dashboardContent.style.display = 'none';
  }
}

init();
