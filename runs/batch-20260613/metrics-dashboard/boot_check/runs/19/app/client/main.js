const API_BASE = 'http://localhost:3000/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before paint
    const settingsRes = await fetch(`${API_BASE}/settings`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme);

    // Fetch all data
    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(`${API_BASE}/summary`),
      fetch(`${API_BASE}/timeseries`),
      fetch(`${API_BASE}/categories`),
      fetch(`${API_BASE}/recent`)
    ]);

    if (!summaryRes.ok || !timeseriesRes.ok || !categoriesRes.ok || !recentRes.ok) {
      throw new Error('Failed to fetch dashboard data');
    }

    const summary = await summaryRes.json();
    timeseriesData = await timeseriesRes.json();
    const categories = await categoriesRes.json();
    const recent = await recentRes.json();

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    
    document.getElementById('dashboard').style.display = 'block';
    
    // Draw chart
    drawChart();
    window.addEventListener('resize', drawChart);

  } catch (err) {
    console.error(err);
    document.getElementById('error-state').style.display = 'block';
    document.getElementById('error-message').textContent = err.message;
  }
}

function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

document.getElementById('theme-toggle').addEventListener('click', async () => {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  drawChart(); // Redraw chart to update colors
  
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to save theme', err);
  }
});

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('stat-revenue').textContent = '$' + Number(summary.totalRevenue).toLocaleString();
  
  const bestDate = new Date(summary.bestDay * 1000).toLocaleDateString();
  document.getElementById('stat-best-day').textContent = bestDate;
  
  const trend = summary.trendPercent;
  const trendEl = document.getElementById('stat-trend');
  trendEl.textContent = (trend > 0 ? '+' : '') + trend.toFixed(1) + '%';
  trendEl.style.color = trend >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('category-breakdown');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => Number(c.value)));
  
  categories.forEach(cat => {
    const val = Number(cat.value);
    const pct = maxVal === 0 ? 0 : (val / maxVal) * 100;
    
    const row = document.createElement('div');
    row.className = 'category-row';
    
    row.innerHTML = `
      <div class="category-label-container">
        <div class="category-name" title="${cat.name}">${cat.name}</div>
        <div class="category-value">${val.toLocaleString()}</div>
      </div>
      <div class="category-bar-bg">
        <div class="category-bar-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(row);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  
  recent.forEach(item => {
    const tr = document.createElement('tr');
    const date = new Date(item.created_at * 1000).toLocaleDateString();
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>$${Number(item.value).toLocaleString()}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData.length) return;
  
  const canvas = document.getElementById('timeseries-chart');
  const container = document.getElementById('chart-container');
  
  // Handle high DPI displays
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;
  
  ctx.clearRect(0, 0, width, height);
  
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  let maxRev = Math.max(...timeseriesData.map(d => Number(d.revenue)));
  if (maxRev === 0) maxRev = 100; // Prevent division by zero
  const minRev = 0;
  
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
    const y = padding.top + chartHeight - (chartHeight * (i / yTicks));
    
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    
    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 10, y);
  }
  
  // Draw X axis labels (sparse)
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const dataPoint = timeseriesData[index];
    if (!dataPoint) continue;
    
    const x = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    const date = new Date(dataPoint.date * 1000);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
    
    if (i === 0) ctx.textAlign = 'left';
    else if (i === xTicks) ctx.textAlign = 'right';
    else ctx.textAlign = 'center';
    
    ctx.fillText(dateStr, x, padding.top + chartHeight + 10);
  }
  
  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * ((Number(d.revenue) - minRev) / (maxRev - minRev)));
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
}

init();
