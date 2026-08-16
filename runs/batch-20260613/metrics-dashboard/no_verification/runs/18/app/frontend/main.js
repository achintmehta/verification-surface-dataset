const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before first paint if possible
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
    
    document.getElementById('error-state').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');

    drawChart();
    window.addEventListener('resize', drawChart);

  } catch (err) {
    console.error(err);
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
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
  trendEl.textContent = (trendVal > 0 ? '+' : '') + trendVal.toFixed(1) + '%';
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';
  if (categories.length === 0) return;
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));
  
  categories.forEach(cat => {
    const val = parseFloat(cat.value);
    const pct = (val / maxVal) * 100;
    
    const item = document.createElement('div');
    item.className = 'category-bar-item';
    
    item.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${cat.name}">${cat.name}</span>
        <span class="category-value">${formatCurrency(val)}</span>
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
  
  recent.forEach(item => {
    const tr = document.createElement('tr');
    const dateStr = new Date(item.created_at).toLocaleDateString();
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>${formatCurrency(parseFloat(item.value))}</td>
      <td>${dateStr}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData || timeseriesData.length === 0) return;
  
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
  
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
  const minRev = 0; // Start Y axis at 0
  
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
  
  // Draw X axis labels (sparse)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const dataPoint = timeseriesData[index];
    if (!dataPoint) continue;
    
    const x = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    const dateStr = new Date(dataPoint.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    
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
  
  // Fill area under line
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.closePath();
  
  // Create gradient
  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
  // Convert hex to rgba for gradient
  const hexToRgb = (hex) => {
    let r = 0, g = 0, b = 0;
    if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 7) {
      r = parseInt(hex.substring(1, 3), 16);
      g = parseInt(hex.substring(3, 5), 16);
      b = parseInt(hex.substring(5, 7), 16);
    }
    return `${r}, ${g}, ${b}`;
  };
  
  let rgb = '59, 130, 246'; // default primary
  if (lineColor.startsWith('#')) {
    rgb = hexToRgb(lineColor);
  }
  
  gradient.addColorStop(0, `rgba(${rgb}, 0.2)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  
  ctx.fillStyle = gradient;
  ctx.fill();
}

init();