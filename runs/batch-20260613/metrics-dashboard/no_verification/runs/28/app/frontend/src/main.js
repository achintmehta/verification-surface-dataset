const API_BASE = '/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  try {
    const [summary, timeseries, categories, recent, settings] = await Promise.all([
      fetchJSON(`${API_BASE}/summary`),
      fetchJSON(`${API_BASE}/timeseries`),
      fetchJSON(`${API_BASE}/categories`),
      fetchJSON(`${API_BASE}/recent`),
      fetchJSON(`${API_BASE}/settings`)
    ]);

    renderSummary(summary);
    renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecent(recent);
    applyTheme(settings.theme || 'light');

    // Hide error if shown
    document.getElementById('error-state').classList.add('hidden');
  } catch (err) {
    console.error('Failed to load data:', err);
    document.getElementById('error-state').classList.remove('hidden');
    // Show empty states
    document.getElementById('total-visitors').textContent = '—';
    document.getElementById('total-revenue').textContent = '—';
  }
}

function renderSummary(summary) {
  document.getElementById('total-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('total-revenue').textContent = '$' + parseFloat(summary.totalRevenue).toLocaleString();
  document.getElementById('best-day').textContent = new Date(summary.bestDay).toLocaleDateString();
  document.getElementById('best-day-visitors').textContent = summary.bestDayVisitors.toLocaleString() + ' visitors';
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? '#22c55e' : '#ef4444';
}

function renderTimeseries(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

  // Clear previous
  svg.innerHTML = '';

  if (!data || data.length === 0) return;

  const container = document.getElementById('timeseries-container');
  const width = container.clientWidth || 600;
  const height = container.clientHeight || 280;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const padding = { top: 20, right: 30, bottom: 40, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const visitors = data.map(d => d.visitors);
  const maxV = Math.max(...visitors);
  const minV = Math.min(...visitors);
  const range = maxV - minV || 1;

  // Gridlines and Y axis
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartHeight * i / yTicks);
    const val = Math.round(maxV - (range * i / yTicks));

    // horizontal grid
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
    text.textContent = val.toLocaleString();
    svg.appendChild(text);
  }

  // X axis labels (every ~5 days)
  const n = data.length;
  for (let i = 0; i < n; i += Math.ceil(n / 6)) {
    const x = padding.left + (chartWidth * i / (n - 1));
    const d = new Date(data[i].date);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - padding.bottom + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-size', '10');
    text.textContent = label;
    svg.appendChild(text);

    // vertical tick
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('y1', height - padding.bottom);
    tick.setAttribute('x2', x);
    tick.setAttribute('y2', height - padding.bottom + 5);
    tick.setAttribute('stroke', 'var(--chart-grid)');
    tick.setAttribute('stroke-width', '1');
    svg.appendChild(tick);
  }

  // Draw the line
  let pathD = '';
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (n - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minV) / range);
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
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * i / (n - 1));
    const y = padding.top + chartHeight - (chartHeight * (d.visitors - minV) / range);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'var(--chart-line)');
    svg.appendChild(circle);
  });
}

function renderCategories(cats) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  if (!cats || cats.length === 0) return;

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
    const pct = (cat.value / maxVal) * 100;
    bar.style.width = pct + '%';

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + (cat.value / 1000).toFixed(0) + 'k';

    barContainer.appendChild(bar);
    row.appendChild(name);
    row.appendChild(barContainer);
    row.appendChild(value);
    container.appendChild(row);
  });
}

function renderRecent(items) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const tr = document.createElement('tr');
    const date = new Date(item.created_at).toLocaleDateString();
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${parseFloat(item.value).toFixed(2)}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(tr);
  });
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Redraw chart with new theme colors
  setTimeout(() => {
    const svg = document.getElementById('timeseries-chart');
    if (svg && svg.children.length > 0) {
      // Re-fetch and redraw? For simplicity, reload data which re-renders
      // But to avoid full reload, just trigger resize handler which redraws
      window.dispatchEvent(new Event('resize'));
    }
  }, 50);
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
    applyTheme(newTheme);
  } catch (e) {
    console.error('Failed to save theme', e);
    applyTheme(newTheme); // still apply locally
  }
}

function setupResizeHandler() {
  const redrawChart = () => {
    // Re-render timeseries by fetching again? To keep simple, we store data
    // For this impl, we'll just reload full data on resize (cheap)
    loadData();
  };

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      redrawChart();
    }, 150);
  });
}

function init() {
  // Theme toggle
  const toggleBtn = document.getElementById('theme-toggle');
  toggleBtn.addEventListener('click', toggleTheme);

  // Initial load
  loadData();

  // Resize handling for chart
  setupResizeHandler();

  // Initial theme load already in loadData
}

init();