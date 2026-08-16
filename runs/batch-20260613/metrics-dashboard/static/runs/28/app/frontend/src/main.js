const API_BASE = '/api';

let currentTheme = 'light';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSettings() {
  try {
    const settings = await fetchJSON(`${API_BASE}/settings`);
    applyTheme(settings.theme || 'light');
  } catch (e) {
    applyTheme('light');
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

async function saveTheme(theme) {
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function setupThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
    // Redraw chart with new theme colors
    if (window.lastChartData) {
      renderChart(window.lastChartData);
    }
  });
}

async function loadDashboard() {
  const errorBanner = document.getElementById('error-banner');
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`)
    ]);

    // Render stats
    document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
    document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
    document.getElementById('best-day').textContent = summary.bestDay;

    const trendEl = document.getElementById('trend-value');
    const indicator = document.getElementById('trend-indicator');
    const trend = summary.trend;
    trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
    indicator.textContent = trend >= 0 ? '↑' : '↓';
    indicator.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';

    // Render chart
    window.lastChartData = timeseries;
    renderChart(timeseries);

    // Render categories
    renderCategories(categories);

    // Render table
    renderTable(recent);

    errorBanner.style.display = 'none';
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    errorBanner.style.display = 'block';
    // Show placeholders
    document.getElementById('total-visitors').textContent = '—';
    document.getElementById('total-revenue').textContent = '—';
    document.getElementById('best-day').textContent = '—';
    document.getElementById('trend-value').textContent = '—';
  }
}

function renderChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg || !data || data.length === 0) return;

  // Clear previous
  svg.innerHTML = '';

  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  const margin = { top: 20, right: 30, bottom: 40, left: 50 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const isDark = currentTheme === 'dark';
  const textColor = isDark ? '#e2e8f0' : '#475569';
  const gridColor = isDark ? '#475569' : '#e2e8f0';
  const lineColor = isDark ? '#60a5fa' : '#3b82f6';

  // Scales
  const visitors = data.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const rangeV = maxV - minV || 1;

  const points = data.map((d, i) => {
    const x = margin.left + (i / (data.length - 1)) * chartWidth;
    const y = margin.top + chartHeight - ((d.visitors - minV) / rangeV) * chartHeight;
    return { x, y, ...d };
  });

  // Grid lines (horizontal)
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = margin.top + (i / gridLines) * chartHeight;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', margin.left + chartWidth);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', gridColor);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y-axis labels
    const val = Math.round(maxV - (i / gridLines) * rangeV);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', margin.left - 10);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', textColor);
    label.setAttribute('font-size', '11');
    label.textContent = val.toLocaleString();
    svg.appendChild(label);
  }

  // X-axis line
  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', margin.left);
  xAxis.setAttribute('y1', margin.top + chartHeight);
  xAxis.setAttribute('x2', margin.left + chartWidth);
  xAxis.setAttribute('y2', margin.top + chartHeight);
  xAxis.setAttribute('stroke', gridColor);
  xAxis.setAttribute('stroke-width', '1');
  svg.appendChild(xAxis);

  // X labels (every ~5 days)
  data.forEach((d, i) => {
    if (i % 5 === 0 || i === data.length - 1) {
      const x = margin.left + (i / (data.length - 1)) * chartWidth;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', margin.top + chartHeight + 20);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', textColor);
      label.setAttribute('font-size', '10');
      label.textContent = d.date.slice(5); // MM-DD
      svg.appendChild(label);
    }
  });

  // Line path
  let pathD = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    pathD += ` L ${points[i].x} ${points[i].y}`;
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', lineColor);
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Dots
  points.forEach(p => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x);
    circle.setAttribute('cy', p.y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', lineColor);
    svg.appendChild(circle);
  });
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';

  if (!categories || categories.length === 0) return;

  const maxVal = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;

    const item = document.createElement('div');
    item.className = 'category-item';

    item.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${cat.name}">${cat.name}</span>
        <span class="category-value">$${cat.value.toLocaleString()}</span>
      </div>
      <div class="bar-container">
        <div class="bar" style="width: ${pct}%"></div>
      </div>
    `;

    container.appendChild(item);
  });
}

function renderTable(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${item.created_at}</td>
    `;
    tbody.appendChild(row);
  });
}

function setupResizeHandler() {
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (window.lastChartData) {
        renderChart(window.lastChartData);
      }
    }, 150);
  });

  // Also observe container
  const container = document.getElementById('chart-container');
  if (container && window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (window.lastChartData) {
        renderChart(window.lastChartData);
      }
    });
    ro.observe(container);
  }
}

async function init() {
  await loadSettings();
  setupThemeToggle();
  setupResizeHandler();
  await loadDashboard();
}

init();