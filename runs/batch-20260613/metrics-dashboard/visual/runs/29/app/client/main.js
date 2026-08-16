const API_BASE = '';

let currentTheme = 'light';

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSettings() {
  try {
    const { theme } = await fetchJSON(`${API_BASE}/api/settings`);
    applyTheme(theme);
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
    await fetchJSON(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    await saveTheme(newTheme);
    // Redraw chart with new theme
    if (window.lastTimeseriesData) {
      drawTimeseriesChart(window.lastTimeseriesData);
    }
  });
}

async function loadDashboard() {
  const errorBanner = document.getElementById('error-banner');
  errorBanner.classList.add('hidden');

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API_BASE}/api/summary`),
      fetchJSON(`${API_BASE}/api/timeseries`),
      fetchJSON(`${API_BASE}/api/categories`),
      fetchJSON(`${API_BASE}/api/recent`)
    ]);

    renderStats(summary);
    window.lastTimeseriesData = timeseries;
    drawTimeseriesChart(timeseries);
    renderCategories(categories);
    renderRecentTable(recent);

    // Setup resize handler for chart
    window.addEventListener('resize', () => {
      if (window.lastTimeseriesData) {
        drawTimeseriesChart(window.lastTimeseriesData);
      }
    });
  } catch (e) {
    errorBanner.textContent = 'Failed to load dashboard data. Is the backend running?';
    errorBanner.classList.remove('hidden');
    console.error(e);
  }
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
  document.getElementById('best-day').textContent = summary.bestDay;
  document.getElementById('best-day-value').textContent = summary.bestDayVisitors.toLocaleString() + ' visitors';
  const trendEl = document.getElementById('trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? '#16a34a' : '#dc2626';
}

function drawTimeseriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  const container = svg.parentElement;
  const width = container.clientWidth || 600;
  const height = 300;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = '';

  if (!data || data.length === 0) return;

  const padding = { top: 20, right: 30, bottom: 40, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const visitors = data.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const minDate = new Date(data[0].date);
  const maxDate = new Date(data[data.length - 1].date);

  const xScale = (date) => padding.left + ((new Date(date) - minDate) / (maxDate - minDate)) * chartWidth;
  const yScale = (v) => padding.top + chartHeight - ((v - minV) / (maxV - minV || 1)) * chartHeight;

  // Gridlines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = minV + (maxV - minV) * (i / yTicks);
    const y = yScale(v);
    // grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // y label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', padding.left - 8);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '11');
    text.textContent = Math.round(v).toLocaleString();
    svg.appendChild(text);
  }

  // X axis labels (every 5 days)
  for (let i = 0; i < data.length; i += 5) {
    const d = data[i];
    const x = xScale(d.date);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', padding.top);
    line.setAttribute('x2', x);
    line.setAttribute('y2', height - padding.bottom);
    line.setAttribute('stroke', 'var(--chart-grid)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - padding.bottom + 18);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '10');
    text.textContent = d.date.slice(5);
    svg.appendChild(text);
  }

  // Line path
  let pathD = '';
  data.forEach((d, i) => {
    const x = xScale(d.date);
    const y = yScale(d.visitors);
    pathD += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD.trim());
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--chart-line)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);

  // Dots
  data.forEach((d) => {
    const x = xScale(d.date);
    const y = yScale(d.visitors);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '2.5');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });
}

function renderCategories(cats) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  const maxVal = Math.max(...cats.map(c => c.value));

  cats.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-row';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name;

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    bar.style.width = (cat.value / maxVal * 100) + '%';

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    barContainer.appendChild(bar);
    row.appendChild(name);
    row.appendChild(barContainer);
    row.appendChild(value);
    container.appendChild(row);
  });
}

function renderRecentTable(items) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const tr = document.createElement('tr');
    const date = new Date(item.created_at).toISOString().split('T')[0];
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function init() {
  await loadSettings();
  setupThemeToggle();
  await loadDashboard();
}

init();