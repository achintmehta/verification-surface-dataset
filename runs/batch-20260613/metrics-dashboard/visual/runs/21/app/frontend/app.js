// ===== Configuration =====
const API_BASE = window.location.port === '5173'
  ? 'http://localhost:3001'
  : '';

// ===== State =====
let currentTheme = 'light';
let timeseriesData = [];

// ===== Utilities =====
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
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatShortDate(dateStr) {
  if (!dateStr) return '';
  // dateStr might be "2024-11-01" or "2024-11-01T00:00:00.000Z"
  const parts = dateStr.substring(0, 10).split('-');
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  return `${month}/${day}`;
}

// ===== Theme =====
async function loadTheme() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    if (!res.ok) throw new Error('Failed to load settings');
    const data = await res.json();
    applyTheme(data.theme || 'light');
  } catch {
    applyTheme('light');
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (theme === 'dark') {
    icon.textContent = '☀️';
    label.textContent = 'Light';
  } else {
    icon.textContent = '🌙';
    label.textContent = 'Dark';
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  // Redraw chart with new theme colors after style recalculation
  requestAnimationFrame(() => {
    if (timeseriesData.length > 0) {
      drawTimeseriesChart(timeseriesData);
    }
  });
  try {
    await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to persist theme:', err);
  }
}

// ===== Data Loading =====
async function loadDashboard() {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  try {
    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(`${API_BASE}/api/summary`),
      fetch(`${API_BASE}/api/timeseries`),
      fetch(`${API_BASE}/api/categories`),
      fetch(`${API_BASE}/api/recent`)
    ]);

    if (!summaryRes.ok || !timeseriesRes.ok || !categoriesRes.ok || !recentRes.ok) {
      throw new Error('One or more API calls failed');
    }

    const summary = await summaryRes.json();
    const timeseries = await timeseriesRes.json();
    const categories = await categoriesRes.json();
    const recent = await recentRes.json();

    // Hide loading, show content
    loadingEl.style.display = 'none';
    errorEl.style.display = 'none';
    contentEl.style.display = 'block';

    renderSummary(summary);
    timeseriesData = timeseries;
    drawTimeseriesChart(timeseries);
    renderCategories(categories);
    renderRecentItems(recent);

  } catch (err) {
    console.error('Dashboard load error:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'flex';
    contentEl.style.display = 'none';
  }
}

// ===== Render: Summary Cards =====
function renderSummary(data) {
  document.getElementById('val-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('val-revenue').textContent = formatCurrency(data.totalRevenue);

  if (data.bestDay) {
    document.getElementById('val-bestday').textContent = formatCurrency(data.bestDay.revenue);
    document.getElementById('sub-bestday').textContent = formatDate(data.bestDay.date);
  }

  const trendVal = data.sevenDayTrend;
  const trendEl = document.getElementById('val-trend');
  const trendDir = document.getElementById('trend-direction');
  const trendSign = trendVal >= 0 ? '+' : '';
  trendEl.textContent = `${trendSign}${trendVal}%`;
  trendEl.style.color = trendVal >= 0
    ? 'var(--trend-up)'
    : 'var(--trend-down)';
  trendDir.textContent = trendVal >= 0 ? '↑ vs previous 7 days' : '↓ vs previous 7 days';
  trendDir.className = 'stat-card__trend ' + (trendVal >= 0 ? 'up' : 'down');

  // Visitors trend indicator
  const vTrend = document.getElementById('trend-visitors');
  vTrend.textContent = `${trendSign}${trendVal}% 7-day trend`;
  vTrend.className = 'stat-card__trend ' + (trendVal >= 0 ? 'up' : 'down');
}

// ===== Render: Time-series Chart (SVG) =====
function drawTimeseriesChart(data) {
  const wrapper = document.getElementById('timeseries-wrapper');
  const svg = document.getElementById('timeseries-chart');

  const rect = wrapper.getBoundingClientRect();
  const width = Math.floor(rect.width) || 600;
  const height = 300;

  // Get computed theme colors
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim() || '#e2e8f0';
  const axisColor = style.getPropertyValue('--chart-axis').trim() || '#94a3b8';
  const lineColor = style.getPropertyValue('--chart-line').trim() || '#4f46e5';
  const fillColor = style.getPropertyValue('--chart-fill').trim() || 'rgba(79,70,229,0.1)';
  const dotColor = style.getPropertyValue('--chart-dot').trim() || '#4f46e5';
  const textColor = style.getPropertyValue('--text-secondary').trim() || '#555770';

  // Margins
  const margin = { top: 20, right: 20, bottom: 45, left: 55 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  if (chartWidth <= 0 || chartHeight <= 0) return;

  // Data bounds
  const visitors = data.map(d => d.visitors);
  const minVal = Math.min(...visitors);
  const maxVal = Math.max(...visitors);
  const padding = (maxVal - minVal) * 0.1 || 100;
  const yMin = Math.max(0, Math.floor((minVal - padding) / 100) * 100);
  const yMax = Math.ceil((maxVal + padding) / 100) * 100;

  // Scales
  const xScale = (i) => margin.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (v) => margin.top + chartHeight - ((v - yMin) / (yMax - yMin)) * chartHeight;

  // Build SVG content
  let svgContent = '';

  // Y-axis gridlines and labels
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (yMax - yMin) * (i / yTicks);
    const y = yScale(val);
    svgContent += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="4,4" />`;
    svgContent += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="${textColor}" font-size="11">${Math.round(val).toLocaleString()}</text>`;
  }

  // X-axis labels (show ~6 labels evenly spaced)
  const labelCount = Math.min(6, data.length);
  const labelStep = Math.max(1, Math.floor((data.length - 1) / (labelCount - 1)));
  for (let i = 0; i < data.length; i += labelStep) {
    const x = xScale(i);
    const label = formatShortDate(data[i].date);
    svgContent += `<text x="${x}" y="${height - margin.bottom + 20}" text-anchor="middle" fill="${textColor}" font-size="11">${label}</text>`;
    svgContent += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + chartHeight}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,4" />`;
  }
  // Always show last label if not already shown
  const lastIdx = data.length - 1;
  if (lastIdx % labelStep !== 0) {
    const x = xScale(lastIdx);
    const label = formatShortDate(data[lastIdx].date);
    svgContent += `<text x="${x}" y="${height - margin.bottom + 20}" text-anchor="middle" fill="${textColor}" font-size="11">${label}</text>`;
  }

  // Area fill
  let areaPath = `M${xScale(0)},${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L${xScale(i)},${yScale(data[i].visitors)}`;
  }
  areaPath += ` L${xScale(data.length - 1)},${margin.top + chartHeight}`;
  areaPath += ` L${xScale(0)},${margin.top + chartHeight} Z`;
  svgContent += `<path d="${areaPath}" fill="${fillColor}" />`;

  // Line
  let linePath = `M${xScale(0)},${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L${xScale(i)},${yScale(data[i].visitors)}`;
  }
  svgContent += `<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;

  // Dots
  for (let i = 0; i < data.length; i++) {
    const cx = xScale(i);
    const cy = yScale(data[i].visitors);
    svgContent += `<circle cx="${cx}" cy="${cy}" r="3" fill="${dotColor}" stroke="${fillColor}" stroke-width="1" />`;
  }

  // Axes
  svgContent += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="${axisColor}" stroke-width="1.5" />`;
  svgContent += `<line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="${axisColor}" stroke-width="1.5" />`;

  // Y-axis label
  svgContent += `<text x="${14}" y="${margin.top + chartHeight / 2}" text-anchor="middle" fill="${textColor}" font-size="11" transform="rotate(-90, 14, ${margin.top + chartHeight / 2})">Visitors</text>`;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = svgContent;
}

// ===== Render: Categories =====
function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  const maxValue = Math.max(...categories.map(c => c.value));

  container.innerHTML = categories.map(cat => {
    const pct = (cat.value / maxValue * 100).toFixed(1);
    return `
      <div class="category-item">
        <div class="category-item__header">
          <span class="category-item__name" title="${cat.name}">${cat.name}</span>
          <span class="category-item__value">${formatNumber(cat.value)}</span>
        </div>
        <div class="category-item__bar">
          <div class="category-item__bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ===== Render: Recent Items =====
function renderRecentItems(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = items.map(item => `
    <tr>
      <td title="${item.name}">${item.name}</td>
      <td title="${item.category}">${item.category}</td>
      <td>${formatCurrency(item.value)}</td>
      <td>${formatDate(item.createdAt)}</td>
    </tr>
  `).join('');
}

// ===== Resize Handler =====
let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (timeseriesData.length > 0) {
      drawTimeseriesChart(timeseriesData);
    }
  }, 150);
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', async () => {
  // Load theme first to avoid FOUC
  await loadTheme();

  // Wire up toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Load data
  await loadDashboard();

  // Resize handler
  window.addEventListener('resize', handleResize);
});
