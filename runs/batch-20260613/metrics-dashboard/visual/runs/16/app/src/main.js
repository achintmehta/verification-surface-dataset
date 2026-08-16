let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before rendering
    const settingsRes = await fetch('/api/settings');
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme);

    // Fetch all data
    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch('/api/summary'),
      fetch('/api/timeseries'),
      fetch('/api/categories'),
      fetch('/api/recent')
    ]);

    if (!summaryRes.ok || !timeseriesRes.ok || !categoriesRes.ok || !recentRes.ok) {
      throw new Error('Failed to fetch data');
    }

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

  } catch (err) {
    console.error(err);
    document.getElementById('error-state').classList.remove('hidden');
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
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (e) {
    console.error('Failed to save theme', e);
  }
});

function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function formatNumber(val) {
  return new Intl.NumberFormat('en-US').format(val);
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('stat-best-day').textContent = formatCurrency(summary.bestDayRevenue);
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trendPercent;
  trendEl.textContent = `${trendVal > 0 ? '+' : ''}${trendVal.toFixed(1)}%`;
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));
  
  categories.forEach(cat => {
    const val = parseFloat(cat.value);
    const pct = maxVal === 0 ? 0 : (val / maxVal) * 100;
    
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${cat.name}">${cat.name}</span>
        <span class="category-value">${formatCurrency(val)}</span>
      </div>
      <div class="category-bar-bg">
        <div class="category-bar-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  
  recent.forEach(item => {
    const tr = document.createElement('tr');
    const date = new Date(item.created_at).toLocaleDateString();
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>${formatCurrency(parseFloat(item.value))}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData.length) return;
  
  const container = document.getElementById('chart-container');
  const canvas = document.getElementById('timeseries-chart');
  const ctx = canvas.getContext('2d');
  
  // Handle high DPI displays
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;
  
  ctx.clearRect(0, 0, width, height);
  
  // Get CSS variables for colors
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--primary-color').trim();
  
  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
  const minRev = 0;
  
  ctx.font = '12px sans-serif';
  const maxRevStr = formatCurrency(maxRev);
  const maxRevWidth = ctx.measureText(maxRevStr).width;
  
  const padding = { top: 20, right: 20, bottom: 30, left: Math.max(60, maxRevWidth + 15) };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  // Draw grid and Y axis labels
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
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
    
    ctx.fillText(formatCurrency(val), padding.left - 10, y);
  }
  
  // Draw X axis labels (sparse)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const dataPoint = timeseriesData[index];
    if (!dataPoint) continue;
    
    const x = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    const date = new Date(dataPoint.date);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
    
    ctx.fillText(dateStr, x, height - padding.bottom + 10);
  }
  
  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * (parseFloat(d.revenue) / maxRev));
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
}

init();