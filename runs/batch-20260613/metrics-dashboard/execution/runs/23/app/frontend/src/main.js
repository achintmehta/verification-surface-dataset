// ========== API Helpers ==========
const API_BASE = '/api';

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

// ========== Theme ==========
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
  // Redraw chart with new colors
  if (window.__timeseriesData) {
    drawChart(window.__timeseriesData);
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
  } catch (err) {
    console.error('Failed to persist theme:', err);
  }
}

// ========== Formatters ==========
function formatNumber(n) {
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

// ========== Stat Cards ==========
function renderStatCards(summary) {
  const container = document.getElementById('stat-cards');
  const trendClass = summary.trendPct >= 0 ? 'trend-up' : 'trend-down';
  const trendArrow = summary.trendPct >= 0 ? '↑' : '↓';

  container.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total Visitors</div>
      <div class="stat-value">${formatNumber(summary.totalVisitors)}</div>
      <div class="stat-sub">Last 30 days</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value">${formatCurrency(summary.totalRevenue)}</div>
      <div class="stat-sub">Last 30 days</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Best Day</div>
      <div class="stat-value">${formatNumber(summary.bestDay.visitors)}</div>
      <div class="stat-sub">${formatDate(summary.bestDay.date)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">7-Day Trend</div>
      <div class="stat-value ${trendClass}">${trendArrow} ${Math.abs(summary.trendPct)}%</div>
      <div class="stat-sub">vs previous 7 days</div>
    </div>
  `;
}

// ========== SVG Chart ==========
function drawChart(data) {
  window.__timeseriesData = data;
  const container = document.getElementById('chart-container');
  if (!container || !data || data.length === 0) return;

  const containerWidth = container.clientWidth;
  if (containerWidth <= 0) return;

  // Dimensions
  const width = containerWidth;
  const height = Math.max(200, Math.min(320, containerWidth * 0.5));
  const margin = { top: 20, right: 20, bottom: 44, left: 55 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Compute theme colors from CSS custom properties
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim() || '#e0e4ea';
  const axisColor = style.getPropertyValue('--chart-axis').trim() || '#555566';
  const lineColor = style.getPropertyValue('--chart-line').trim() || '#3b82f6';
  const fillColor = style.getPropertyValue('--chart-fill').trim() || 'rgba(59,130,246,0.1)';
  const surfaceColor = style.getPropertyValue('--surface').trim() || '#ffffff';

  // Data ranges
  const visitors = data.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const paddedMin = Math.max(0, minV - (maxV - minV) * 0.1);
  const paddedMax = maxV + (maxV - minV) * 0.1;
  const range = paddedMax - paddedMin || 1;

  // Scale functions
  const xScale = (i) => margin.left + (i / (data.length - 1)) * plotW;
  const yScale = (v) => margin.top + plotH - ((v - paddedMin) / range) * plotH;

  // Build SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Visitors time series chart">`;

  // Background
  svg += `<rect x="0" y="0" width="${width}" height="${height}" fill="${surfaceColor}" rx="8"/>`;

  // Horizontal gridlines + y-axis labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = paddedMin + (range / yTicks) * i;
    const y = yScale(val);
    // Gridline
    svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="4,3"/>`;
    // Label
    const label = val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val).toString();
    svg += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${axisColor}" font-family="sans-serif">${label}</text>`;
  }

  // Area fill
  let areaPath = `M ${xScale(0)},${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xScale(i)},${yScale(data[i].visitors)}`;
  }
  areaPath += ` L ${xScale(data.length - 1)},${margin.top + plotH}`;
  areaPath += ` L ${xScale(0)},${margin.top + plotH} Z`;
  svg += `<path d="${areaPath}" fill="${fillColor}"/>`;

  // Line
  let linePath = `M ${xScale(0)},${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xScale(i)},${yScale(data[i].visitors)}`;
  }
  svg += `<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Data points
  for (let i = 0; i < data.length; i++) {
    const cx = xScale(i);
    const cy = yScale(data[i].visitors);
    svg += `<circle cx="${cx}" cy="${cy}" r="3" fill="${lineColor}" stroke="${surfaceColor}" stroke-width="1.5"/>`;
  }

  // X-axis labels - show a reasonable number depending on width
  const maxLabels = Math.max(3, Math.floor(plotW / 55));
  const labelStep = Math.max(1, Math.ceil(data.length / maxLabels));
  for (let i = 0; i < data.length; i += labelStep) {
    const x = xScale(i);
    const label = formatDateShort(data[i].metric_date);
    svg += `<text x="${x}" y="${margin.top + plotH + 18}" text-anchor="middle" font-size="10" fill="${axisColor}" font-family="sans-serif">${label}</text>`;
  }
  // Always show last label
  if ((data.length - 1) % labelStep !== 0) {
    const x = xScale(data.length - 1);
    const label = formatDateShort(data[data.length - 1].metric_date);
    svg += `<text x="${x}" y="${margin.top + plotH + 18}" text-anchor="middle" font-size="10" fill="${axisColor}" font-family="sans-serif">${label}</text>`;
  }

  // Axis lines
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1"/>`;
  svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="${axisColor}" stroke-width="1"/>`;

  svg += '</svg>';

  container.innerHTML = svg;
}

// ========== Categories ==========
function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  if (!container || !categories || categories.length === 0) return;

  const maxVal = Math.max(...categories.map(c => Number(c.value)));

  container.innerHTML = categories.map(cat => {
    const pct = maxVal > 0 ? (Number(cat.value) / maxVal * 100) : 0;
    return `
      <div class="category-row">
        <span class="category-label" title="${cat.name}">${cat.name}</span>
        <div class="category-bar-wrapper">
          <div class="category-bar-track">
            <div class="category-bar-fill" style="width: ${pct}%"></div>
          </div>
          <span class="category-value">${formatNumber(Number(cat.value))}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ========== Recent Items Table ==========
function renderTable(items) {
  const wrapper = document.getElementById('table-wrapper');
  if (!wrapper || !items || items.length === 0) return;

  const rows = items.map(item => `
    <tr>
      <td class="cell-truncate" title="${item.name}">${item.name}</td>
      <td class="cell-truncate" title="${item.category}">${item.category}</td>
      <td>${formatCurrency(parseFloat(item.value))}</td>
      <td>${formatDate(item.created_at)}</td>
    </tr>
  `).join('');

  wrapper.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th>Value</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ========== Resize Handler ==========
let resizeTimeout;
function onResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (window.__timeseriesData) {
      drawChart(window.__timeseriesData);
    }
  }, 150);
}

// ========== Init ==========
async function init() {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  // Load theme first (before data fetch) to minimize flash
  await loadTheme();

  // Set up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/summary'),
      apiFetch('/timeseries'),
      apiFetch('/categories'),
      apiFetch('/recent')
    ]);

    // Hide loading, show content
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Render all sections
    renderStatCards(summary);
    drawChart(timeseries);
    renderCategories(categories);
    renderTable(recent);

    // Listen for resizes
    window.addEventListener('resize', onResize);

  } catch (err) {
    console.error('Failed to load dashboard:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    contentEl.style.display = 'none';
  }
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
