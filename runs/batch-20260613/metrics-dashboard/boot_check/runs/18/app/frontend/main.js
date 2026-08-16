const API_URL = 'http://localhost:3001/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before rendering
    const settingsRes = await fetch(`${API_URL}/settings`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme);
    
    // Show body now that theme is applied
    document.body.classList.add('ready');

    // Fetch all data
    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(`${API_URL}/summary`),
      fetch(`${API_URL}/timeseries`),
      fetch(`${API_URL}/categories`),
      fetch(`${API_URL}/recent`)
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
    document.body.classList.add('ready');
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
    await fetch(`${API_URL}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to save theme', err);
  }
});

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = Number(summary.total_visitors).toLocaleString();
  document.getElementById('stat-revenue').textContent = '$' + Number(summary.total_revenue).toLocaleString();
  document.getElementById('stat-best-day').textContent = summary.best_day_date;
  document.getElementById('stat-trend').textContent = summary.trend_percent.toFixed(2) + '%';
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => Number(c.value)));
  
  categories.forEach(c => {
    const val = Number(c.value);
    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const item = document.createElement('div');
    item.className = 'category-item';
    
    item.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${c.name}">${c.name}</span>
        <span class="category-value">$${val.toLocaleString()}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderRecent(recent) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';
  
  recent.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.category}</td>
      <td>$${Number(r.value).toLocaleString()}</td>
      <td>${new Date(r.created_at).toLocaleDateString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData.length) return;
  
  const canvas = document.getElementById('timeseries-chart');
  const container = canvas.parentElement;
  
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;
  
  ctx.clearRect(0, 0, width, height);
  
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxRev = Math.max(...timeseriesData.map(d => Number(d.revenue)));
  const minRev = 0;
  const range = maxRev > 0 ? maxRev : 1;
  
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textColor;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + chartHeight - (i / yTicks) * chartHeight;
    const val = minRev + (i / yTicks) * range;
    
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    
    ctx.fillText(Math.round(val), padding.left - 10, y);
  }
  
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((i / xTicks) * (timeseriesData.length - 1));
    const x = padding.left + (index / (timeseriesData.length - 1)) * chartWidth;
    
    const dateStr = timeseriesData[index].date;
    const dateObj = new Date(dateStr);
    const label = `${dateObj.getMonth()+1}/${dateObj.getDate()}`;
    
    ctx.fillText(label, x, height - padding.bottom + 10);
  }
  
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (i / (timeseriesData.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - (Number(d.revenue) / range) * chartHeight;
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
}

init();
