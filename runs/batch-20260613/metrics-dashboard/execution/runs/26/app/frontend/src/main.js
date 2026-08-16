const API_BASE = '/api';

let currentTheme = 'light';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadDashboard() {
  const errorBanner = document.getElementById('error-banner');
  errorBanner.classList.add('hidden');

  try {
    // Load settings first for theme
    const settings = await fetchJSON(`${API_BASE}/settings`);
    applyTheme(settings.theme);

    // Fetch all data
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`)
    ]);

    renderStats(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderTable(recent);

    // Setup resize handler for chart
    setupChartResize(timeseries);

    // Theme toggle
    setupThemeToggle();

  } catch (err) {
    console.error('Failed to load dashboard:', err);
    errorBanner.textContent = 'Failed to load data from server. Please ensure the backend is running.';
    errorBanner.classList.remove('hidden');
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

function setupThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.onclick = async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    try {
      await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: newTheme })
      });
      applyTheme(newTheme);
      // Redraw chart with new theme colors
      const timeseries = await fetchJSON(`${API_BASE}/timeseries`);
      renderChart(timeseries);
    } catch (e) {
      console.error('Failed to save theme', e);
    }
  };
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 });

  const bestDate = new Date(summary.bestDay.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  document.getElementById('best-day').textContent = summary.bestDay.visitors.toLocaleString();
  document.getElementById('best-day-sub').textContent = bestDate;

  const trendEl = document.getElementById('trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

let chartData = null;
let resizeHandler = null;

function getChartColors() {
  const isDark = currentTheme === 'dark';
  return {
    line: isDark ? '#60a5fa' : '#3b82f6',
    grid: isDark ? '#334155' : '#e2e8f0',
    axis: isDark ? '#94a3b8' : '#64748b'
  };
}

function renderChart(data) {
  chartData = data;
  const svg = document.getElementById('timeseries-chart');
  const container = document.getElementById('chart-container');

  // Clear previous
  svg.innerHTML = '';

  const width = container.clientWidth || 600;
  const height = 300;
  const margin = { top: 20, right: 30, bottom: 40, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const visitors = data.map(d => d.visitors);
  const maxV = Math.max(...visitors);
  const minV = Math.min(...visitors);
  const range = maxV - minV || 1;

  const points = data.map((d, i) => {
    const x = margin.left + (i / (data.length - 1)) * chartWidth;
    const y = margin.top + chartHeight - ((d.visitors - minV) / range) * chartHeight;
    return { x, y, ...d };
  });

  // Gridlines and axes
  const ns = 'http://www.w3.org/2000/svg';
  const colors = getChartColors();

  // Horizontal gridlines
  for (let i = 0; i <= 4; i++) {
    const y = margin.top + (i / 4) * chartHeight;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', margin.left + chartWidth);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', colors.grid);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y tick label
    const val = Math.round(maxV - (i / 4) * range);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', margin.left - 10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', colors.axis);
    text.setAttribute('font-size', '11');
    text.textContent = val.toLocaleString();
    svg.appendChild(text);
  }

  // X axis line
  const xAxis = document.createElementNS(ns, 'line');
  xAxis.setAttribute('x1', margin.left);
  xAxis.setAttribute('y1', margin.top + chartHeight);
  xAxis.setAttribute('x2', margin.left + chartWidth);
  xAxis.setAttribute('y2', margin.top + chartHeight);
  xAxis.setAttribute('stroke', colors.axis);
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  // X ticks - show every 5 days
  data.forEach((d, i) => {
    if (i % 5 === 0 || i === data.length - 1) {
      const x = margin.left + (i / (data.length - 1)) * chartWidth;
      const tick = document.createElementNS(ns, 'line');
      tick.setAttribute('x1', x);
      tick.setAttribute('y1', margin.top + chartHeight);
      tick.setAttribute('x2', x);
      tick.setAttribute('y2', margin.top + chartHeight + 6);
      tick.setAttribute('stroke', colors.axis);
      tick.setAttribute('stroke-width', '1');
      svg.appendChild(tick);

      const date = new Date(d.date);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', margin.top + chartHeight + 20);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', colors.axis);
      label.setAttribute('font-size', '10');
      label.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      svg.appendChild(label);
    }
  });

  // Line path
  let pathD = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    pathD += ` L ${points[i].x} ${points[i].y}`;
  }

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', colors.line);
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Dots
  points.forEach(p => {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', p.x);
    dot.setAttribute('cy', p.y);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', colors.line);
    svg.appendChild(dot);
  });
}

function setupChartResize(data) {
  const container = document.getElementById('chart-container');
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);

  resizeHandler = () => {
    if (chartData) renderChart(chartData);
  };
  window.addEventListener('resize', resizeHandler);

  // Also use ResizeObserver for container
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (chartData) renderChart(chartData);
    });
    ro.observe(container);
  }
}

function renderCategories(cats) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';

  const maxVal = Math.max(...cats.map(c => c.value));

  cats.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const header = document.createElement('div');
    header.className = 'category-header';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // for tooltip

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    header.appendChild(name);
    header.appendChild(value);

    const barContainer = document.createElement('div');
    barContainer.className = 'bar-container';

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = (cat.value / maxVal * 100) + '%';

    barContainer.appendChild(bar);

    item.appendChild(header);
    item.appendChild(barContainer);
    container.appendChild(item);
  });
}

function renderTable(items) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const row = document.createElement('tr');
    const date = new Date(item.created_at).toLocaleDateString();

    row.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(row);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// Initial load
loadDashboard();