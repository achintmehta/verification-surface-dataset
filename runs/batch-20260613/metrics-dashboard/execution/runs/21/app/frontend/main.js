// ========== API Helpers ==========

const API_BASE = '/api';

async function fetchJSON(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function putJSON(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ========== Theme Management ==========

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
  } catch (err) {
    console.error('Failed to save theme:', err);
  }
}

// ========== Number Formatting ==========

function formatNumber(n) {
  if (typeof n !== 'number') return String(n);
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  if (typeof n !== 'number') return String(n);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ========== Render Summary Stats ==========

function renderSummary(data) {
  document.getElementById('val-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('val-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('val-bestday').textContent = data.bestDay;
  document.getElementById('val-trend').textContent =
    (data.trendPct >= 0 ? '+' : '') + data.trendPct + '%';

  const trendEl = document.getElementById('trend-visitors');
  if (data.trendPct >= 0) {
    trendEl.textContent = '↑ Trending up';
    trendEl.className = 'stat-card__trend up';
  } else {
    trendEl.textContent = '↓ Trending down';
    trendEl.className = 'stat-card__trend down';
  }

  // Also style the trend card
  const trendCard = document.getElementById('val-trend');
  if (data.trendPct >= 0) {
    trendCard.style.color = 'var(--trend-up)';
  } else {
    trendCard.style.color = 'var(--trend-down)';
  }
}

// ========== SVG Chart ==========

let timeseriesData = [];

function createSVGElement(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function drawChart() {
  const container = document.getElementById('chart-container');
  const svg = document.getElementById('chart-svg');
  if (!container || !svg || timeseriesData.length === 0) return;

  const rect = container.getBoundingClientRect();
  const W = Math.floor(rect.width);
  const H = Math.floor(rect.height);

  if (W <= 0 || H <= 0) return;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);

  // Clear
  svg.innerHTML = '';

  const data = timeseriesData;
  const n = data.length;

  // Margins
  const marginTop = 20;
  const marginRight = 16;
  const marginBottom = 50;
  const marginLeft = 52;

  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Scales
  const values = data.map(d => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const valRange = maxVal - minVal || 1;
  const padding = valRange * 0.1;
  const yMin = Math.floor((minVal - padding) / 100) * 100;
  const yMax = Math.ceil((maxVal + padding) / 100) * 100;

  function xScale(i) {
    return marginLeft + (i / (n - 1)) * plotW;
  }

  function yScale(v) {
    return marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  }

  // Compute CSS variable values for theming
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const axisColor = style.getPropertyValue('--chart-axis').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const fillColor = style.getPropertyValue('--chart-fill').trim();
  const dotColor = style.getPropertyValue('--chart-dot').trim();

  // Gridlines & Y-axis ticks
  const yTickCount = 5;
  const yStep = (yMax - yMin) / yTickCount;
  for (let i = 0; i <= yTickCount; i++) {
    const v = yMin + i * yStep;
    const y = yScale(v);

    // Gridline
    svg.appendChild(createSVGElement('line', {
      x1: marginLeft, y1: y, x2: W - marginRight, y2: y,
      stroke: gridColor, 'stroke-width': '1', 'stroke-dasharray': '4,3',
    }));

    // Y label
    const label = createSVGElement('text', {
      x: marginLeft - 8, y: y + 4,
      'text-anchor': 'end', 'font-size': '11', fill: axisColor,
      'font-family': 'var(--font-family)',
    });
    label.textContent = Math.round(v).toLocaleString('en-US');
    svg.appendChild(label);
  }

  // X-axis ticks (show every Nth depending on width)
  const xTickInterval = W < 500 ? 7 : W < 700 ? 5 : 3;
  for (let i = 0; i < n; i++) {
    if (i % xTickInterval === 0 || i === n - 1) {
      const x = xScale(i);
      // Tick mark
      svg.appendChild(createSVGElement('line', {
        x1: x, y1: marginTop + plotH, x2: x, y2: marginTop + plotH + 6,
        stroke: axisColor, 'stroke-width': '1',
      }));

      // Label
      const dateLabel = data[i].date.slice(5); // MM-DD
      const text = createSVGElement('text', {
        x: x, y: marginTop + plotH + 22,
        'text-anchor': 'middle', 'font-size': '10', fill: axisColor,
        'font-family': 'var(--font-family)',
      });
      text.textContent = dateLabel;
      svg.appendChild(text);
    }
  }

  // Axes
  svg.appendChild(createSVGElement('line', {
    x1: marginLeft, y1: marginTop, x2: marginLeft, y2: marginTop + plotH,
    stroke: axisColor, 'stroke-width': '1',
  }));
  svg.appendChild(createSVGElement('line', {
    x1: marginLeft, y1: marginTop + plotH, x2: W - marginRight, y2: marginTop + plotH,
    stroke: axisColor, 'stroke-width': '1',
  }));

  // Area fill
  let areaPath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < n; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }
  areaPath += ` L ${xScale(n - 1)} ${marginTop + plotH} L ${xScale(0)} ${marginTop + plotH} Z`;
  svg.appendChild(createSVGElement('path', {
    d: areaPath, fill: fillColor, stroke: 'none',
  }));

  // Line
  let linePath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < n; i++) {
    linePath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }
  svg.appendChild(createSVGElement('path', {
    d: linePath, fill: 'none', stroke: lineColor, 'stroke-width': '2',
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // Dots
  for (let i = 0; i < n; i++) {
    svg.appendChild(createSVGElement('circle', {
      cx: xScale(i), cy: yScale(data[i].visitors), r: W < 500 ? '2' : '3',
      fill: dotColor,
    }));
  }
}

// ========== Categories ==========

function renderCategories(data) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';
  const maxVal = Math.max(...data.map(d => d.value));

  for (const cat of data) {
    const pct = maxVal > 0 ? (cat.value / maxVal * 100) : 0;

    const row = document.createElement('div');
    row.className = 'category-row';

    const header = document.createElement('div');
    header.className = 'category-row__header';

    const nameEl = document.createElement('span');
    nameEl.className = 'category-row__name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name; // tooltip for truncated names

    const valueEl = document.createElement('span');
    valueEl.className = 'category-row__value';
    valueEl.textContent = formatNumber(cat.value);

    header.appendChild(nameEl);
    header.appendChild(valueEl);

    const barBg = document.createElement('div');
    barBg.className = 'category-row__bar-bg';

    const barFill = document.createElement('div');
    barFill.className = 'category-row__bar-fill';
    barFill.style.width = pct + '%';

    barBg.appendChild(barFill);
    row.appendChild(header);
    row.appendChild(barBg);
    container.appendChild(row);
  }
}

// ========== Table ==========

function renderTable(data) {
  const tbody = document.getElementById('table-body');
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
    tdVal.textContent = formatNumber(item.value);

    const tdDate = document.createElement('td');
    tdDate.textContent = item.createdAt;

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    tbody.appendChild(tr);
  }
}

// ========== Resize Handling ==========

let resizeTimer;
function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawChart();
  }, 100);
}

// ========== Init ==========

async function init() {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');
  const toggleBtn = document.getElementById('theme-toggle');

  // Load theme first (before data, to minimize flash)
  await loadTheme();

  // Theme toggle handler
  toggleBtn.addEventListener('click', toggleTheme);

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
    contentEl.style.display = '';

    // Render everything
    renderSummary(summary);

    timeseriesData = timeseries;
    // Draw chart after a brief delay to ensure container has dimensions
    requestAnimationFrame(() => {
      drawChart();
    });

    renderCategories(categories);
    renderTable(recent);

    // Resize handler
    window.addEventListener('resize', handleResize);

    // Also observe the chart container for size changes
    if (typeof ResizeObserver !== 'undefined') {
      const chartContainer = document.getElementById('chart-container');
      const ro = new ResizeObserver(() => {
        drawChart();
      });
      ro.observe(chartContainer);
    }

  } catch (err) {
    console.error('Failed to load dashboard:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = '';
    document.getElementById('error-message').textContent =
      'Failed to load dashboard data. Please ensure the backend server is running.';
  }
}

// Also redraw chart when theme changes (to pick up new CSS variable colors)
const origApplyTheme = applyTheme;
// We need to redraw after theme change
const themeObserver = new MutationObserver(() => {
  if (timeseriesData.length > 0) {
    // Small delay to let CSS variables update
    requestAnimationFrame(() => drawChart());
  }
});
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});

init();
