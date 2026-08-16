const API_BASE = '/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before rendering
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
    
    // Render chart
    renderChart();
    window.addEventListener('resize', renderChart);

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
  renderChart(); // Redraw chart to update colors
  try {
    await fetch(`${API_BASE}/settings`, {
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
  
  if (summary.bestDay) {
    document.getElementById('stat-best-day').textContent = formatCurrency(summary.bestDay.revenue);
    const bestDate = new Date(summary.bestDay.date);
    document.getElementById('stat-best-day-date').textContent = `${bestDate.getUTCMonth() + 1}/${bestDate.getUTCDate()}/${bestDate.getUTCFullYear()}`;
  }
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trend;
  trendEl.textContent = `${trendVal > 0 ? '+' : ''}${trendVal.toFixed(1)}%`;
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';
  if (categories.length === 0) return;
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));
  
  categories.forEach(cat => {
    const val = parseFloat(cat.value);
    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const row = document.createElement('div');
    row.className = 'category-row';
    
    const header = document.createElement('div');
    header.className = 'category-header';
    
    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name;
    
    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = formatCurrency(val);
    
    header.appendChild(name);
    header.appendChild(value);
    
    const barBg = document.createElement('div');
    barBg.className = 'category-bar-bg';
    
    const barFill = document.createElement('div');
    barFill.className = 'category-bar-fill';
    barFill.style.width = `${pct}%`;
    
    barBg.appendChild(barFill);
    
    row.appendChild(header);
    row.appendChild(barBg);
    
    container.appendChild(row);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  
  recent.forEach(item => {
    const tr = document.createElement('tr');
    
    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    
    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;
    
    const tdVal = document.createElement('td');
    tdVal.textContent = formatCurrency(parseFloat(item.value));
    
    const tdDate = document.createElement('td');
    tdDate.textContent = new Date(item.created_at).toLocaleString();
    
    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    
    tbody.appendChild(tr);
  });
}

function renderChart() {
  if (!timeseriesData || timeseriesData.length === 0) return;
  
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
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
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
    
    ctx.fillText(formatCurrency(val), padding.left - 10, y);
  }
  
  // Draw X axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const dataPoint = timeseriesData[index];
    if (!dataPoint) continue;
    
    const x = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    const date = new Date(dataPoint.date);
    const dateStr = `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    
    ctx.fillText(dateStr, x, height - padding.bottom + 10);
  }
  
  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * (parseFloat(d.revenue) / maxRev));
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.stroke();
}

init();