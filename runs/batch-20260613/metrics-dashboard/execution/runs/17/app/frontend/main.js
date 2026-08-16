const API_BASE = 'http://localhost:3000/api';

let timeseriesData = [];
let chartInstance = null;

async function init() {
  try {
    const settingsRes = await fetch(`${API_BASE}/settings`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme);

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
    
    drawChart();
    window.addEventListener('resize', () => {
      requestAnimationFrame(drawChart);
    });

  } catch (err) {
    console.error(err);
    document.getElementById('error-state').classList.remove('hidden');
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

document.getElementById('theme-toggle').addEventListener('click', async () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  
  drawChart();

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
  document.getElementById('stat-best-day').textContent = formatCurrency(summary.bestDay.revenue);
  const bestDate = new Date(summary.bestDay.date);
  document.getElementById('stat-best-day-date').textContent = bestDate.toLocaleDateString();
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trendPercent;
  trendEl.textContent = `${trendVal > 0 ? '+' : ''}${trendVal.toFixed(1)}%`;
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)), 1);
  
  categories.forEach(c => {
    const val = parseFloat(c.value);
    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const el = document.createElement('div');
    el.className = 'category-item';
    el.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${c.name}">${c.name}</span>
        <span class="category-value">${formatCurrency(val)}</span>
      </div>
      <div class="category-bar-bg">
        <div class="category-bar-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(el);
  });
}

function renderRecent(recent) {
  const tbody = document.getElementById('recent-items-tbody');
  tbody.innerHTML = '';
  
  recent.forEach(r => {
    const tr = document.createElement('tr');
    const d = new Date(r.created_at);
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.category}</td>
      <td>${formatCurrency(parseFloat(r.value))}</td>
      <td>${d.toLocaleDateString()} ${d.toLocaleTimeString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData.length) return;
  
  const canvas = document.getElementById('timeseries-chart');
  const wrapper = canvas.parentElement;
  
  const rect = wrapper.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const width = canvas.width - padding.left - padding.right;
  const height = canvas.height - padding.top - padding.bottom;
  
  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)), 1);
  const minRev = 0;
  
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minRev + (maxRev - minRev) * (i / yTicks);
    const y = canvas.height - padding.bottom - (height * (i / yTicks));
    
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(canvas.width - padding.right, y);
    ctx.stroke();
    
    ctx.fillText(formatCurrency(val), padding.left - 10, y);
  }
  
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const d = timeseriesData[index];
    const x = padding.left + (width * (index / (timeseriesData.length - 1)));
    
    const dateObj = new Date(d.date);
    const dateStr = `${dateObj.getMonth()+1}/${dateObj.getDate()}`;
    ctx.fillText(dateStr, x, canvas.height - padding.bottom + 10);
  }
  
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (width * (i / (timeseriesData.length - 1)));
    const y = canvas.height - padding.bottom - (height * (parseFloat(d.revenue) / maxRev));
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
  
  ctx.lineTo(padding.left + width, canvas.height - padding.bottom);
  ctx.lineTo(padding.left, canvas.height - padding.bottom);
  ctx.closePath();
  
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.globalAlpha = 1.0;
}

init();