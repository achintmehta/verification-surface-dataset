/* ===== Metrics Dashboard - Client ===== */

const API_BASE = '';

// ===== State =====
let currentTheme = 'light';
let timeseriesData = [];
let categoriesData = [];

// ===== DOM Elements =====
const $ = (id) => document.getElementById(id);

// ===== API Helpers =====
async function apiFetch(path) {
  const resp = await fetch(`${API_BASE}${path}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

async function apiPut(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// ===== Theme =====
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
  $('theme-label').textContent = theme === 'dark' ? 'Light' : 'Dark';
  // Redraw charts with new colors
  if (timeseriesData.length) drawTimeseries(timeseriesData);
  if (categoriesData.length) renderCategories(categoriesData);
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await apiPut('/api/settings', { theme: newTheme });
  } catch (e) {
    console.error('Failed to persist theme:', e);
  }
}

// ===== Number Formatting =====
function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ===== Render Stat Cards =====
function renderSummary(data) {
  $('val-visitors').textContent = fmtNumber(data.totalVisitors);
  $('val-revenue').textContent = fmtCurrency(data.totalRevenue);

  if (data.bestDay) {
    $('val-bestday').textContent = fmtNumber(data.bestDay.visitors) + ' visitors';
    $('val-bestday-date').textContent = fmtDate(data.bestDay.date);
  }

  const trend = data.trend7d;
  const sign = trend >= 0 ? '+' : '';
  $('val-trend').textContent = sign + trend.toFixed(1) + '%';
  const indicator = $('val-trend-indicator');
  indicator.textContent = trend >= 0 ? '▲ Trending up' : '▼ Trending down';
  indicator.className = 'stat-card__indicator ' + (trend >= 0 ? 'positive' : 'negative');
}

// ===== Timeseries Chart (SVG) =====
function drawTimeseries(data) {
  const container = $('timeseries-container');
  const svg = $('timeseries-chart');
  const rect = container.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  if (W === 0 || H === 0) return;

  // Get theme colors from CSS custom properties
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const fillColor = style.getPropertyValue('--chart-fill').trim();
  const textColor = style.getPropertyValue('--text-muted').trim();

  // Margins
  const ml = 50, mr = 16, mt = 12, mb = 32;
  const plotW = W - ml - mr;
  const plotH = H - mt - mb;

  const visitors = data.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const range = maxV - minV || 1;

  // Compute nice Y ticks
  const yStep = niceStep(range, 5);
  const yMin = Math.floor(minV / yStep) * yStep;
  const yMax = Math.ceil(maxV / yStep) * yStep;
  const yRange = yMax - yMin || 1;

  function xPos(i) { return ml + (i / (data.length - 1)) * plotW; }
  function yPos(v) { return mt + plotH - ((v - yMin) / yRange) * plotH; }

  let svgContent = '';

  // Gridlines + Y labels
  for (let v = yMin; v <= yMax; v += yStep) {
    const y = yPos(v);
    svgContent += `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="4,3"/>`;
    svgContent += `<text x="${ml - 6}" y="${y + 4}" text-anchor="end" fill="${textColor}" font-size="10" font-family="sans-serif">${abbreviateNum(v)}</text>`;
  }

  // X labels (show ~6 labels max)
  const labelInterval = Math.max(1, Math.floor(data.length / 6));
  for (let i = 0; i < data.length; i += labelInterval) {
    const x = xPos(i);
    svgContent += `<text x="${x}" y="${H - 6}" text-anchor="middle" fill="${textColor}" font-size="10" font-family="sans-serif">${fmtDate(data[i].date)}</text>`;
  }
  // Always show last label
  if ((data.length - 1) % labelInterval !== 0) {
    const x = xPos(data.length - 1);
    svgContent += `<text x="${x}" y="${H - 6}" text-anchor="end" fill="${textColor}" font-size="10" font-family="sans-serif">${fmtDate(data[data.length - 1].date)}</text>`;
  }

  // Area fill
  let areaPath = `M ${xPos(0)} ${yPos(visitors[0])}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xPos(i)} ${yPos(visitors[i])}`;
  }
  areaPath += ` L ${xPos(data.length - 1)} ${mt + plotH} L ${xPos(0)} ${mt + plotH} Z`;
  svgContent += `<path d="${areaPath}" fill="${fillColor}"/>`;

  // Line
  let linePath = `M ${xPos(0)} ${yPos(visitors[0])}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xPos(i)} ${yPos(visitors[i])}`;
  }
  svgContent += `<path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Dots on data points
  for (let i = 0; i < data.length; i++) {
    svgContent += `<circle cx="${xPos(i)}" cy="${yPos(visitors[i])}" r="3" fill="${lineColor}" stroke="none"/>`;
  }

  // Axis lines
  svgContent += `<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" stroke="${axisColor}" stroke-width="1"/>`;
  svgContent += `<line x1="${ml}" y1="${mt + plotH}" x2="${W - mr}" y2="${mt + plotH}" stroke="${axisColor}" stroke-width="1"/>`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = svgContent;
}

function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  let nice;
  if (frac <= 1.5) nice = 1;
  else if (frac <= 3.5) nice = 2;
  else if (frac <= 7.5) nice = 5;
  else nice = 10;
  return nice * pow;
}

function abbreviateNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(n);
}

// ===== Category Breakdown =====
function renderCategories(data) {
  categoriesData = data;
  const container = $('categories-container');
  if (!data.length) {
    container.innerHTML = '<p style="color:var(--text-muted)">No category data</p>';
    return;
  }

  const maxVal = Math.max(...data.map(d => d.value));

  container.innerHTML = data.map(cat => {
    const pct = (cat.value / maxVal) * 100;
    return `
      <div class="category-row">
        <div class="category-row__header">
          <span class="category-row__name" title="${escHtml(cat.name)}">${escHtml(cat.name)}</span>
          <span class="category-row__value">${fmtNumber(cat.value)}</span>
        </div>
        <div class="category-row__bar-bg">
          <div class="category-row__bar-fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ===== Recent Items Table =====
function renderRecentTable(data) {
  const tbody = $('recent-tbody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No recent items</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td title="${escHtml(item.name)}">${escHtml(item.name)}</td>
      <td title="${escHtml(item.category)}">${escHtml(item.category)}</td>
      <td>${fmtCurrency(item.value)}</td>
      <td>${fmtDateTime(item.created_at)}</td>
    </tr>
  `).join('');
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Resize Handler =====
let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (timeseriesData.length) drawTimeseries(timeseriesData);
  }, 100);
}

// ===== Init =====
async function init() {
  // Wire up theme toggle
  $('theme-toggle').addEventListener('click', toggleTheme);
  window.addEventListener('resize', onResize);

  try {
    // Load settings first to apply theme before paint
    const settings = await apiFetch('/api/settings');
    applyTheme(settings.theme || 'light');

    // Load all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/api/summary'),
      apiFetch('/api/timeseries'),
      apiFetch('/api/categories'),
      apiFetch('/api/recent'),
    ]);

    // Hide loading, show content
    $('loading-state').style.display = 'none';
    $('dashboard-content').style.display = 'block';

    // Render everything
    renderSummary(summary);

    timeseriesData = timeseries;
    drawTimeseries(timeseries);

    categoriesData = categories;
    renderCategories(categories);

    renderRecentTable(recent);

  } catch (err) {
    console.error('Failed to load dashboard:', err);
    $('loading-state').style.display = 'none';
    $('error-state').style.display = 'block';
  }
}

// Start
document.addEventListener('DOMContentLoaded', init);
