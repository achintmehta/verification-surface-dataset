const API_BASE = '/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before rendering
    const settingsRes = await fetch(`${API_BASE}/settings`);
    if (!settingsRes.ok) throw new Error('API not reachable');
    const settings = await settingsRes.json();
    setTheme(settings.theme);

    // Fetch all data
    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(`${API_BASE}/summary`),
      fetch(`${API_BASE}/timeseries`),
      fetch(`${API_BASE}/categories`),
      fetch(`${API_BASE}/recent`)
    ]);

    const summary = await summaryRes.json();
    timeseriesData = await timeseriesRes.json();
    const categories = await categoriesRes.json();
    const recent = await recentRes.json();

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    
    document.getElementById('dashboard').classList.remove('hidden');
    
    // Draw chart
    drawChart();
    window.addEventListener('resize', drawChart);

  } catch (e) {
    console.error(e);
    document.getElementById('error-state').classList.remove('hidden');
  }

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
}

function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  drawChart(); // Redraw chart to update colors
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (e) {
    console.error('Failed to save theme', e);
  }
}

function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function formatNumber(val) {
  return new Intl.NumberFormat('en-US').format(val);
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('stat-best-day').textContent = summary.bestDay ? summary.bestDay.split('T')[0] : '--';
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = parseFloat(summary.trend);
  trendEl.textContent = `${trendVal > 0 ? '+' : ''}${summary.trend}%`;
  trendEl.style.color = trendVal >= 0 ? 'green' : 'red';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-breakdown');
  container.innerHTML = '';
  if (categories.length === 0) return;

  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));

  categories.forEach(c => {
    const val = parseFloat(c.value);
    const pct = (val / maxVal) * 100;
    
    const item = document.createElement('div');
    item.className = 'category-item';
    
    item.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${c.name}">${c.name}</span>
        <span class="category-value">${formatCurrency(val)}</span>
      </div>
      <div class="category-bar-bg">
        <div class="category-bar-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  
  recent.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.category}</td>
      <td>${formatCurrency(parseFloat(r.value))}</td>
      <td>${new Date(r.created_at).toLocaleDateString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData || timeseriesData.length === 0) return;

  const canvas = document.getElementById('timeseries-chart');
  const wrapper = document.getElementById('timeseries-wrapper');
  
  // Handle high DPI displays
  const dpr = window.devicePixelRatio || 1;
  const rect = wrapper.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);

  // Get CSS variables for colors
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();

  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
  const minRev = 0; // Start Y axis at 0

  // Draw Grid and Y-axis labels
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minRev + (maxRev - minRev) * (i / yTicks);
    const y = padding.top + chartHeight - (chartHeight * (i / yTicks));
    
    // Grid line
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Label
    ctx.fillText(formatCurrency(val), padding.left - 10, y);
  }

  // Draw X-axis labels (sparse)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const d = timeseriesData[index];
    if (!d) continue;
    
    const x = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    const dateStr = new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    
    ctx.fillText(dateStr, x, padding.top + chartHeight + 10);
  }

  // Draw Line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';

  timeseriesData.forEach((d, i) => {
    const rev = parseFloat(d.revenue);
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * ((rev - minRev) / (maxRev - minRev)));
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
}

init();