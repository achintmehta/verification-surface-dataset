// ==================== API Layer ====================
const API_BASE = '/api';

async function fetchJSON(url) {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function putJSON(url, data) {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ==================== Theme Management ====================
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-icon');
  if (icon) {
    if (theme === 'dark') {
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
    } else {
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
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
    console.warn('Failed to persist theme:', e);
  }
}

// ==================== Number Formatting ====================
function formatNumber(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  // Parse YYYY-MM-DD as local date to avoid timezone issues
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ==================== Stat Cards ====================
function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('stat-visitors-sub').textContent = '30-day total';

  document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('stat-revenue-sub').textContent = '30-day total';

  document.getElementById('stat-bestday').textContent = formatNumber(data.bestDay.visitors);
  document.getElementById('stat-bestday-sub').textContent = formatDate(data.bestDay.date);

  const trendEl = document.getElementById('stat-trend');
  const trendVal = data.trendPct;
  const arrow = trendVal >= 0 ? '↑' : '↓';
  trendEl.textContent = `${arrow} ${Math.abs(trendVal)}%`;
  trendEl.classList.add(trendVal >= 0 ? 'trend-up' : 'trend-down');
}

// ==================== Time Series Chart (Canvas) ====================
let timeseriesData = [];

function drawTimeseriesChart() {
  const canvas = document.getElementById('timeseries-chart');
  if (!canvas || !timeseriesData.length) return;

  const wrapper = document.getElementById('timeseries-wrapper');
  const rect = wrapper.getBoundingClientRect();

  // Handle high DPI
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  // Get theme colors from CSS variables
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const fillColor = style.getPropertyValue('--chart-fill').trim();
  const textColor = style.getPropertyValue('--text-secondary').trim();

  // Chart margins
  const margin = { top: 16, right: 16, bottom: 40, left: 50 };
  const chartW = w - margin.left - margin.right;
  const chartH = h - margin.top - margin.bottom;

  if (chartW <= 0 || chartH <= 0) return;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Data
  const values = timeseriesData.map(d => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const padding = range * 0.1;
  const yMin = Math.max(0, minVal - padding);
  const yMax = maxVal + padding;
  const yRange = yMax - yMin;

  // Scale functions
  const xScale = (i) => margin.left + (i / (timeseriesData.length - 1)) * chartW;
  const yScale = (v) => margin.top + chartH - ((v - yMin) / yRange) * chartH;

  // Draw gridlines
  const numGridLines = 5;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= numGridLines; i++) {
    const y = margin.top + (i / numGridLines) * chartH;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + chartW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Y-axis labels
  ctx.fillStyle = textColor;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= numGridLines; i++) {
    const y = margin.top + (i / numGridLines) * chartH;
    const val = yMax - (i / numGridLines) * yRange;
    const label = val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val).toString();
    ctx.fillText(label, margin.left - 8, y);
  }

  // X-axis labels - show a subset to avoid overlap
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelWidth = 52; // approximate width of a date label like "Jan 28"
  const maxLabels = Math.max(2, Math.floor(chartW / labelWidth));
  const step = Math.max(1, Math.ceil(timeseriesData.length / maxLabels));
  const labelsToShow = [];
  for (let i = 0; i < timeseriesData.length; i += step) {
    labelsToShow.push(i);
  }
  // Always include last index, but remove second-to-last if it would overlap
  const lastIdx = timeseriesData.length - 1;
  if (labelsToShow[labelsToShow.length - 1] !== lastIdx) {
    const lastShown = labelsToShow[labelsToShow.length - 1];
    const distPx = xScale(lastIdx) - xScale(lastShown);
    if (distPx < labelWidth) {
      labelsToShow.pop(); // remove the one that would overlap
    }
    labelsToShow.push(lastIdx);
  }
  for (const i of labelsToShow) {
    const x = xScale(i);
    const label = formatDate(timeseriesData[i].date);
    ctx.fillText(label, x, margin.top + chartH + 8);
  }

  // Draw axes
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + chartH);
  ctx.lineTo(margin.left + chartW, margin.top + chartH);
  ctx.stroke();

  // Draw filled area
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(values[0]));
  for (let i = 1; i < values.length; i++) {
    ctx.lineTo(xScale(i), yScale(values[i]));
  }
  ctx.lineTo(xScale(values.length - 1), margin.top + chartH);
  ctx.lineTo(xScale(0), margin.top + chartH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(values[0]));
  for (let i = 1; i < values.length; i++) {
    ctx.lineTo(xScale(i), yScale(values[i]));
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Draw data points (only if sufficient space)
  const dotRadius = chartW > 300 ? 3 : 2;
  if (chartW / values.length > 6) {
    for (let i = 0; i < values.length; i++) {
      ctx.beginPath();
      ctx.arc(xScale(i), yScale(values[i]), dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
    }
  }
}

// ==================== Category Breakdown ====================
function renderCategories(data) {
  const container = document.getElementById('categories-list');
  if (!container) return;

  const maxVal = Math.max(...data.map(d => d.value));

  container.innerHTML = data.map(cat => {
    const pct = (cat.value / maxVal) * 100;
    const displayVal = formatNumber(cat.value);

    return `
      <div class="category-item">
        <div class="category-header">
          <span class="category-name" title="${cat.name}">${cat.name}</span>
          <span class="category-value">${displayVal}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ==================== Recent Items Table ====================
function renderRecentItems(data) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  tbody.innerHTML = data.map(item => `
    <tr>
      <td title="${item.name}">${item.name}</td>
      <td title="${item.category}">${item.category}</td>
      <td>${formatCurrency(parseFloat(item.value))}</td>
      <td>${formatDateTime(item.created_at)}</td>
    </tr>
  `).join('');
}

// ==================== Init ====================
async function init() {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  // Setup theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Load theme first (before data, so it applies quickly)
  await loadTheme();

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent')
    ]);

    // Hide loading, show content
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Render each section
    renderSummary(summary);

    timeseriesData = timeseries;
    drawTimeseriesChart();

    renderCategories(categories);
    renderRecentItems(recent);

  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'flex';
  }
}

// Handle resize for chart
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    drawTimeseriesChart();
  }, 100);
});

// Start
document.addEventListener('DOMContentLoaded', init);
