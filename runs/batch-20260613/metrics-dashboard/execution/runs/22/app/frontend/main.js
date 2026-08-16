// ===== API Helpers =====
const API_BASE = '';

async function fetchJSON(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function putJSON(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ===== Theme Management =====
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  if (label) label.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

async function loadTheme() {
  try {
    const data = await fetchJSON('/api/settings');
    applyTheme(data.theme || 'light');
  } catch (e) {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await putJSON('/api/settings', { theme: newTheme });
  } catch (e) {
    console.error('Failed to persist theme:', e);
  }
}

// ===== Number Formatting =====
function formatNumber(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function formatCurrency(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ===== Render Stat Cards =====
function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('stat-bestday').textContent = formatDate(summary.bestDay);
  
  const trendVal = Number(summary.trendPct);
  const trendEl = document.getElementById('stat-trend');
  trendEl.textContent = (trendVal >= 0 ? '+' : '') + trendVal.toFixed(1) + '%';
  
  const trendIndicator = document.getElementById('stat-trend-indicator');
  if (trendVal > 0) {
    trendIndicator.textContent = '↑ Trending up';
    trendIndicator.className = 'stat-trend up';
  } else if (trendVal < 0) {
    trendIndicator.textContent = '↓ Trending down';
    trendIndicator.className = 'stat-trend down';
  } else {
    trendIndicator.textContent = '→ No change';
    trendIndicator.className = 'stat-trend neutral';
  }
}

// ===== Render Time-Series Chart (SVG) =====
let timeseriesData = null;

function renderTimeseries(data) {
  timeseriesData = data;
  drawTimeseriesChart();
}

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    gridColor: style.getPropertyValue('--chart-grid').trim() || '#e5e7eb',
    axisColor: style.getPropertyValue('--chart-axis').trim() || '#6b7280',
    lineColor: style.getPropertyValue('--chart-line').trim() || '#3b82f6',
    areaColor: style.getPropertyValue('--chart-area').trim() || 'rgba(59,130,246,0.1)',
    textColor: style.getPropertyValue('--text-primary').trim() || '#1a1a2e',
    bgColor: style.getPropertyValue('--bg-card').trim() || '#ffffff'
  };
}

function drawTimeseriesChart() {
  const container = document.getElementById('timeseries-chart');
  if (!container || !timeseriesData || timeseriesData.length === 0) return;

  const containerWidth = container.clientWidth;
  if (containerWidth === 0) return;

  const colors = getThemeColors();
  
  // Chart dimensions
  const margin = { top: 16, right: 16, bottom: 40, left: 52 };
  const width = containerWidth;
  const height = Math.min(300, Math.max(180, containerWidth * 0.45));
  const chartW = width - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;

  const visitors = timeseriesData.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const range = maxV - minV || 1;
  const padding = range * 0.1;
  const yMin = Math.max(0, minV - padding);
  const yMax = maxV + padding;

  // Scale functions
  const xScale = (i) => margin.left + (i / (timeseriesData.length - 1)) * chartW;
  const yScale = (v) => margin.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  // Build SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="30-day visitors time series chart">`;

  // Y-axis gridlines and labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(val);
    svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${colors.gridColor}" stroke-width="1" stroke-dasharray="4,3"/>`;
    svg += `<text x="${margin.left - 6}" y="${y + 4}" text-anchor="end" fill="${colors.axisColor}" font-size="10" font-family="system-ui, sans-serif">${Math.round(val).toLocaleString()}</text>`;
  }

  // Area under curve
  let areaPath = `M ${xScale(0)} ${yScale(visitors[0])}`;
  for (let i = 1; i < visitors.length; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
  }
  areaPath += ` L ${xScale(visitors.length - 1)} ${margin.top + chartH} L ${xScale(0)} ${margin.top + chartH} Z`;
  svg += `<path d="${areaPath}" fill="${colors.areaColor}"/>`;

  // Line
  let linePath = `M ${xScale(0)} ${yScale(visitors[0])}`;
  for (let i = 1; i < visitors.length; i++) {
    linePath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
  }
  svg += `<path d="${linePath}" fill="none" stroke="${colors.lineColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Data points
  for (let i = 0; i < visitors.length; i++) {
    svg += `<circle cx="${xScale(i)}" cy="${yScale(visitors[i])}" r="2.5" fill="${colors.lineColor}" stroke="${colors.bgColor}" stroke-width="1"/>`;
  }

  // X-axis labels - show a subset to avoid overlap
  const labelEvery = containerWidth < 500 ? 7 : containerWidth < 800 ? 5 : 4;
  for (let i = 0; i < timeseriesData.length; i++) {
    if (i % labelEvery === 0 || i === timeseriesData.length - 1) {
      const x = xScale(i);
      const label = formatShortDate(timeseriesData[i].date);
      svg += `<text x="${x}" y="${height - 8}" text-anchor="middle" fill="${colors.axisColor}" font-size="9" font-family="system-ui, sans-serif">${label}</text>`;
    }
  }

  // Y-axis line
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartH}" stroke="${colors.axisColor}" stroke-width="1"/>`;
  // X-axis line
  svg += `<line x1="${margin.left}" y1="${margin.top + chartH}" x2="${width - margin.right}" y2="${margin.top + chartH}" stroke="${colors.axisColor}" stroke-width="1"/>`;

  svg += '</svg>';
  container.innerHTML = svg;
}

// ===== Render Category Breakdown =====
function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  if (!container) return;

  const maxVal = Math.max(...categories.map(c => c.value));

  container.innerHTML = categories.map(cat => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    return `
      <div class="category-row">
        <div class="category-header">
          <span class="category-name" title="${escapeHTML(cat.name)}">${escapeHTML(cat.name)}</span>
          <span class="category-value">${formatNumber(cat.value)}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width: ${pct.toFixed(1)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Render Recent Items Table =====
function renderRecentItems(items) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  tbody.innerHTML = items.map(item => `
    <tr>
      <td title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</td>
      <td title="${escapeHTML(item.category)}">${escapeHTML(item.category)}</td>
      <td>${formatCurrency(item.value)}</td>
      <td>${formatDate(item.created_at)}</td>
    </tr>
  `).join('');
}

// ===== Resize Handling =====
let resizeTimer = null;

function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawTimeseriesChart();
  }, 100);
}

// ===== Main Init =====
async function init() {
  // Load theme first, before dashboard data
  await loadTheme();

  // Set up theme toggle
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleTheme);
  }

  // Set up resize handler
  window.addEventListener('resize', handleResize);

  // Observe theme changes for chart redraw
  const observer = new MutationObserver(() => {
    // Delay slightly to let CSS variables update
    setTimeout(drawTimeseriesChart, 50);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Fetch all data
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/api/summary'),
      fetchJSON('/api/timeseries'),
      fetchJSON('/api/categories'),
      fetchJSON('/api/recent')
    ]);

    loadingEl.style.display = 'none';
    contentEl.style.display = 'grid';

    renderSummary(summary);
    renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecentItems(recent);
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    contentEl.style.display = 'none';
  }
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
