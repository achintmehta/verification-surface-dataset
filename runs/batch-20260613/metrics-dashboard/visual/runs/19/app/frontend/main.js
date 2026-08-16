const API_BASE = 'http://localhost:3001/api';

async function fetchAPI(endpoint, options = {}) {
  const res = await fetch(`${API_BASE}${endpoint}`, options);
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

let timeseriesData = [];

async function init() {
  try {
    // Load settings first to apply theme before paint if possible
    const settings = await fetchAPI('/settings');
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.getElementById('app').classList.add('ready');

    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchAPI('/summary'),
      fetchAPI('/timeseries'),
      fetchAPI('/categories'),
      fetchAPI('/recent')
    ]);

    timeseriesData = timeseries;

    renderSummary(summary);
    renderCategories(categories);
    renderTable(recent);
    
    drawChart();
    window.addEventListener('resize', drawChart);

    // Theme toggle listener
    document.getElementById('theme-toggle').addEventListener('click', async () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      drawChart(); // Redraw chart to update colors
      
      try {
        await fetchAPI('/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: next })
        });
      } catch (e) {
        console.error('Failed to save theme', e);
      }
    });

    // Show dashboard
    document.getElementById('dashboard').classList.remove('hidden');

  } catch (e) {
    console.error(e);
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('app').classList.add('ready');
  }
}

function drawChart() {
  const chartContainer = document.getElementById('chart-container');
  const canvas = document.getElementById('timeseries-chart');
  if (!chartContainer || !canvas) return;

  const ctx = canvas.getContext('2d');
  const rect = chartContainer.getBoundingClientRect();
  
  // Handle high DPI displays
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);

  if (!timeseriesData || timeseriesData.length === 0) return;

  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  let maxRev = Math.max(...timeseriesData.map(d => d.revenue));
  if (maxRev === 0) maxRev = 100;
  const minRev = 0;

  // Get CSS variables for colors
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();

  // Draw grid and Y axis labels
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minRev + (maxRev - minRev) * (i / yTicks);
    const y = padding.top + chartHeight - (i / yTicks) * chartHeight;
    
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 10, y);
  }

  // Draw X axis labels (sparse)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const d = timeseriesData[index];
    const x = padding.left + (index / (timeseriesData.length - 1)) * chartWidth;
    
    // Format date as MM-DD
    const dateStr = d.date.substring(5);
    ctx.fillText(dateStr, x, height - padding.bottom + 10);
  }

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (i / (timeseriesData.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - ((d.revenue - minRev) / (maxRev - minRev)) * chartHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('stat-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
  document.getElementById('stat-best-day').textContent = summary.bestDay;
  document.getElementById('stat-trend').textContent = (summary.trend > 0 ? '+' : '') + summary.trend + '%';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';
  if (!categories || categories.length === 0) return;

  const maxVal = Math.max(...categories.map(c => c.value));

  categories.forEach(c => {
    const pct = (c.value / maxVal) * 100;
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${c.name}">${c.name}</span>
        <span class="category-value">${c.value.toLocaleString()}</span>
      </div>
      <div class="category-bar-bg">
        <div class="category-bar-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderTable(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  recent.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.category}</td>
      <td>${r.value.toLocaleString()}</td>
      <td>${r.created_at}</td>
    `;
    tbody.appendChild(tr);
  });
}

init();