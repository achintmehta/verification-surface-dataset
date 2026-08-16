// ========== API Layer ==========
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

// ========== Formatters ==========
function formatNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateFull(d) {
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ========== Theme ==========
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  // Re-render chart with new theme colors
  if (window.__timeseriesData) {
    drawTimeseries(window.__timeseriesData);
  }
}

async function loadTheme() {
  try {
    const { theme } = await fetchJSON('/settings');
    applyTheme(theme);
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await putJSON('/settings', { theme: newTheme });
  } catch (err) {
    console.error('Failed to persist theme:', err);
  }
}

// ========== Stat Cards ==========
function renderSummary(data) {
  document.getElementById('val-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('val-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('val-bestday').textContent = formatCurrency(data.bestDay?.revenue);
  document.getElementById('val-bestday-date').textContent = data.bestDay
    ? formatDateFull(data.bestDay.date)
    : '';

  const trendEl = document.getElementById('val-trend');
  const trendIndEl = document.getElementById('trend-indicator');
  const pct = data.trendPct;
  const sign = pct >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${pct}%`;

  if (pct > 0) {
    trendEl.style.color = 'var(--trend-up)';
    trendIndEl.textContent = '↑ vs previous 7 days';
    trendIndEl.className = 'card-sub trend-indicator up';
  } else if (pct < 0) {
    trendEl.style.color = 'var(--trend-down)';
    trendIndEl.textContent = '↓ vs previous 7 days';
    trendIndEl.className = 'card-sub trend-indicator down';
  } else {
    trendIndEl.textContent = '→ unchanged';
    trendIndEl.className = 'card-sub trend-indicator';
  }
}

// ========== SVG Timeseries Chart ==========
function drawTimeseries(data) {
  window.__timeseriesData = data;

  const container = document.getElementById('timeseries-container');
  const svg = document.getElementById('timeseries-svg');

  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;

  if (containerWidth === 0 || containerHeight === 0) return;

  // Margins - adapt for narrow widths
  const isNarrow = containerWidth < 400;
  const marginTop = 10;
  const marginRight = isNarrow ? 8 : 16;
  const marginBottom = 40;
  const marginLeft = isNarrow ? 42 : 55;

  const plotW = containerWidth - marginLeft - marginRight;
  const plotH = containerHeight - marginTop - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Compute scales
  const revenues = data.map(d => d.revenue);
  const minRev = Math.min(...revenues);
  const maxRev = Math.max(...revenues);
  const revPadding = (maxRev - minRev) * 0.1 || 1000;
  const yMin = Math.max(0, Math.floor((minRev - revPadding) / 1000) * 1000);
  const yMax = Math.ceil((maxRev + revPadding) / 1000) * 1000;

  const xScale = (i) => marginLeft + (i / (data.length - 1)) * plotW;
  const yScale = (v) => marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Read CSS custom properties for theme-aware colors
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const fillColor = style.getPropertyValue('--chart-fill').trim();
  const textColor = style.getPropertyValue('--text-secondary').trim();

  // Build SVG content
  let svgContent = '';

  // Set explicit dimensions and viewBox
  svg.setAttribute('width', containerWidth);
  svg.setAttribute('height', containerHeight);
  svg.setAttribute('viewBox', `0 0 ${containerWidth} ${containerHeight}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Y-axis gridlines and labels
  const yTicks = isNarrow ? 4 : 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(val);
    // Gridline
    svgContent += `<line x1="${marginLeft}" y1="${y}" x2="${containerWidth - marginRight}" y2="${y}" stroke="${gridColor}" stroke-width="1" />`;
    // Label
    const label = val >= 1000 ? `$${(val / 1000).toFixed(0)}k` : `$${val.toFixed(0)}`;
    svgContent += `<text x="${marginLeft - 8}" y="${y + 4}" text-anchor="end" fill="${axisColor}" font-size="11">${label}</text>`;
  }

  // X-axis labels (show every Nth depending on width)
  const labelEvery = plotW < 400 ? 7 : plotW < 600 ? 5 : 3;
  for (let i = 0; i < data.length; i++) {
    if (i % labelEvery === 0 || i === data.length - 1) {
      const x = xScale(i);
      const label = formatDate(data[i].date);
      svgContent += `<text x="${x}" y="${containerHeight - 8}" text-anchor="middle" fill="${axisColor}" font-size="10">${label}</text>`;
      // Small tick
      svgContent += `<line x1="${x}" y1="${marginTop + plotH}" x2="${x}" y2="${marginTop + plotH + 5}" stroke="${axisColor}" stroke-width="1" />`;
    }
  }

  // Area fill
  let areaPath = `M ${xScale(0)},${yScale(revenues[0])}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xScale(i)},${yScale(revenues[i])}`;
  }
  areaPath += ` L ${xScale(data.length - 1)},${marginTop + plotH} L ${xScale(0)},${marginTop + plotH} Z`;
  svgContent += `<path d="${areaPath}" fill="${fillColor}" />`;

  // Line
  let linePath = `M ${xScale(0)},${yScale(revenues[0])}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xScale(i)},${yScale(revenues[i])}`;
  }
  svgContent += `<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;

  // Data points
  for (let i = 0; i < data.length; i++) {
    const cx = xScale(i);
    const cy = yScale(revenues[i]);
    svgContent += `<circle cx="${cx}" cy="${cy}" r="3" fill="${lineColor}" stroke="var(--surface)" stroke-width="1.5" />`;
  }

  // Axes
  svgContent += `<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotH}" stroke="${axisColor}" stroke-width="1" />`;
  svgContent += `<line x1="${marginLeft}" y1="${marginTop + plotH}" x2="${containerWidth - marginRight}" y2="${marginTop + plotH}" stroke="${axisColor}" stroke-width="1" />`;

  svg.innerHTML = svgContent;
}

// ========== Categories ==========
function renderCategories(data) {
  const container = document.getElementById('categories-container');
  const maxVal = Math.max(...data.map(d => d.value));

  container.innerHTML = data.map(cat => {
    const pct = (cat.value / maxVal) * 100;
    return `
      <div class="category-row">
        <div class="category-header">
          <span class="category-name" title="${cat.name}">${cat.name}</span>
          <span class="category-value">${formatNumber(cat.value)}</span>
        </div>
        <div class="category-bar">
          <div class="category-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ========== Recent Items Table ==========
function renderRecentItems(data) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = data.map(item => {
    return `
      <tr>
        <td>${item.name}</td>
        <td class="category-cell" title="${item.category}">${item.category}</td>
        <td>${formatCurrency(item.value)}</td>
        <td>${formatDateFull(item.created_at)}</td>
      </tr>
    `;
  }).join('');
}

// ========== Resize Handler ==========
let resizeTimer;
function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (window.__timeseriesData) {
      drawTimeseries(window.__timeseriesData);
    }
  }, 100);
}

// ========== Init ==========
async function init() {
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const contentEl = document.getElementById('dashboard-content');

  // Load theme first (before data, so UI looks right)
  await loadTheme();

  // Wire up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent'),
    ]);

    // Hide loading, show content
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Render
    renderSummary(summary);
    renderCategories(categories);
    renderRecentItems(recent);

    // Draw chart after DOM is visible (need container dimensions)
    requestAnimationFrame(() => {
      drawTimeseries(timeseries);
    });

    // Resize listener - both window and container
    window.addEventListener('resize', handleResize);

    // Also use ResizeObserver for the chart container
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        handleResize();
      });
      ro.observe(document.getElementById('timeseries-container'));
    }
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    contentEl.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', init);
