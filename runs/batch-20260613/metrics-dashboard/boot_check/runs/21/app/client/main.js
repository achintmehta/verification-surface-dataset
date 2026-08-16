// ========== API Helpers ==========
const API_BASE = '/api';

async function fetchJSON(url) {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function putJSON(url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ========== Theme Management ==========
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  // Re-render chart if data loaded
  if (window.__timeseriesData) {
    drawTimeseriesChart(window.__timeseriesData);
  }
}

async function loadTheme() {
  try {
    const settings = await fetchJSON('/settings');
    if (settings.theme) {
      applyTheme(settings.theme);
    }
  } catch (e) {
    // Use default light
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await putJSON('/settings', { theme: newTheme });
  } catch (e) {
    console.error('Failed to save theme:', e);
  }
}

// ========== Number Formatting ==========
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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ========== Render Stat Cards ==========
function renderSummary(data) {
  document.getElementById('stat-total-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('stat-total-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('stat-best-day').textContent = formatNumber(data.bestDay.visitors) + ' visitors';
  document.getElementById('stat-best-day-date').textContent = formatDate(data.bestDay.date);

  const trendEl = document.getElementById('stat-trend');
  const pct = data.trendPct;
  const sign = pct >= 0 ? '+' : '';
  trendEl.textContent = sign + pct.toFixed(2) + '%';
  trendEl.className = 'stat-value ' + (pct >= 0 ? 'trend-up' : 'trend-down');
}

// ========== SVG Time-Series Chart ==========
function drawTimeseriesChart(data) {
  window.__timeseriesData = data;

  const container = document.getElementById('timeseries-container');
  const svg = document.getElementById('timeseries-chart');
  if (!container || !svg) return;

  const rect = container.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  if (width <= 0 || height <= 0) return;

  // Get theme-aware colors from CSS variables
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const dotColor = style.getPropertyValue('--chart-dot').trim();
  const areaColor = style.getPropertyValue('--chart-area').trim();
  const textColor = style.getPropertyValue('--text-secondary').trim();

  // Margins
  const marginTop = 16;
  const marginRight = 16;
  const marginBottom = 40;
  const marginLeft = width < 400 ? 40 : 55;

  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Data ranges
  const visitors = data.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const rangeV = maxV - minV || 1;
  const padV = rangeV * 0.1;

  const yMin = Math.max(0, minV - padV);
  const yMax = maxV + padV;
  const yRange = yMax - yMin;

  // Scale functions
  const xScale = (i) => marginLeft + (i / (data.length - 1)) * plotW;
  const yScale = (v) => marginTop + plotH - ((v - yMin) / yRange) * plotH;

  // Build SVG content
  let svgContent = '';

  // Y-axis gridlines and labels
  const numYTicks = 5;
  for (let i = 0; i <= numYTicks; i++) {
    const val = yMin + (yRange * i) / numYTicks;
    const y = yScale(val);
    // Gridline
    svgContent += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="4,3"/>`;
    // Label
    const label = val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val).toString();
    svgContent += `<text x="${marginLeft - 6}" y="${y + 4}" text-anchor="end" fill="${textColor}" font-size="10" font-family="sans-serif">${label}</text>`;
  }

  // X-axis labels
  const totalPoints = data.length;
  const maxXLabels = width < 500 ? 5 : (width < 800 ? 8 : 10);
  const xStep = Math.max(1, Math.ceil(totalPoints / maxXLabels));
  for (let i = 0; i < totalPoints; i += xStep) {
    const x = xScale(i);
    const label = formatDateShort(data[i].date);
    svgContent += `<text x="${x}" y="${height - marginBottom + 18}" text-anchor="middle" fill="${textColor}" font-size="10" font-family="sans-serif">${label}</text>`;
    // Small tick
    svgContent += `<line x1="${x}" y1="${marginTop + plotH}" x2="${x}" y2="${marginTop + plotH + 4}" stroke="${axisColor}" stroke-width="1"/>`;
  }

  // Axes
  svgContent += `<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotH}" stroke="${axisColor}" stroke-width="1.5"/>`;
  svgContent += `<line x1="${marginLeft}" y1="${marginTop + plotH}" x2="${width - marginRight}" y2="${marginTop + plotH}" stroke="${axisColor}" stroke-width="1.5"/>`;

  // Area fill
  let areaPath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }
  areaPath += ` L ${xScale(data.length - 1)} ${marginTop + plotH} L ${xScale(0)} ${marginTop + plotH} Z`;
  svgContent += `<path d="${areaPath}" fill="${areaColor}" stroke="none"/>`;

  // Line
  let linePath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }
  svgContent += `<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Dots
  const showDots = data.length <= 31;
  if (showDots) {
    for (let i = 0; i < data.length; i++) {
      const cx = xScale(i);
      const cy = yScale(data[i].visitors);
      svgContent += `<circle cx="${cx}" cy="${cy}" r="3" fill="${dotColor}" stroke="var(--bg-card)" stroke-width="1.5"/>`;
    }
  }

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = svgContent;
}

// ========== Render Categories ==========
function renderCategories(data) {
  const container = document.getElementById('categories-container');
  if (!container) return;

  const maxVal = Math.max(...data.map(d => d.value));

  let html = '';
  for (const cat of data) {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    html += `
      <div class="category-row">
        <div class="category-header">
          <span class="category-name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
          <span class="category-value">${formatNumber(cat.value)}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========== Render Recent Items Table ==========
function renderRecentItems(data) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  let html = '';
  for (const item of data) {
    html += `
      <tr>
        <td class="td-name">${escapeHtml(item.name)}</td>
        <td class="td-category" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
        <td class="td-value">${formatCurrency(parseFloat(item.value))}</td>
        <td class="td-date">${formatDate(item.created_at)}</td>
      </tr>
    `;
  }
  tbody.innerHTML = html;
}

// ========== Resize Handling ==========
let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (window.__timeseriesData) {
      drawTimeseriesChart(window.__timeseriesData);
    }
  }, 100);
}

// ========== Initialize Dashboard ==========
async function init() {
  // Load theme first (before data) to set correct theme before paint
  await loadTheme();

  // Set up theme toggle
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }

  // Set up resize listener
  window.addEventListener('resize', handleResize);

  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent')
    ]);

    // Hide loading, show content
    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';

    // Render everything
    renderSummary(summary);
    renderCategories(categories);
    renderRecentItems(recent);

    // Draw chart after a microtask so container has dimensions
    requestAnimationFrame(() => {
      drawTimeseriesChart(timeseries);
    });
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'block';
  }
}

// Run
init();
