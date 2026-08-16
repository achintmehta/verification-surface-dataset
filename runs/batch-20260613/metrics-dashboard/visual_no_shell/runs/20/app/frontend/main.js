const API_BASE = '/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    const settingsRes = await fetch(API_BASE + '/settings');
    if (!settingsRes.ok) throw new Error('Failed to load settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme);

    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(API_BASE + '/summary'),
      fetch(API_BASE + '/timeseries'),
      fetch(API_BASE + '/categories'),
      fetch(API_BASE + '/recent')
    ]);

    if (!summaryRes.ok || !timeseriesRes.ok || !categoriesRes.ok || !recentRes.ok) {
      throw new Error('Failed to load data');
    }

    const summary = await summaryRes.json();
    timeseriesData = await timeseriesRes.json();
    const categories = await categoriesRes.json();
    const recent = await recentRes.json();

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('dashboard').style.display = 'grid';

    drawChart();
    window.addEventListener('resize', drawChart);

  } catch (err) {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('error-state').style.display = 'block';
    document.getElementById('error-message').textContent = err.message;
  }
}

function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  drawChart();
}

document.getElementById('theme-toggle').addEventListener('click', async () => {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  try {
    await fetch(API_BASE + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to save theme', err);
  }
});

function formatNumber(num) {
  return new Intl.NumberFormat('en-US').format(num);
}

function formatCurrency(num) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('stat-best-day').textContent = summary.bestDay;
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trendPercent;
  trendEl.textContent = (trendVal > 0 ? '+' : '') + trendVal.toFixed(1) + '%';
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('category-breakdown');
  container.innerHTML = '';
  const maxVal = Math.max(...categories.map(c => c.value));

  categories.forEach(c => {
    const pct = maxVal === 0 ? 0 : (c.value / maxVal) * 100;
    const el = document.createElement('div');
    el.className = 'category-item';
    
    const header = document.createElement('div');
    header.className = 'category-header';
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'category-name';
    nameSpan.title = c.name;
    nameSpan.textContent = c.name;
    
    const valSpan = document.createElement('span');
    valSpan.className = 'category-value';
    valSpan.textContent = formatCurrency(c.value);
    
    header.appendChild(nameSpan);
    header.appendChild(valSpan);
    
    const barBg = document.createElement('div');
    barBg.className = 'category-bar-bg';
    
    const barFill = document.createElement('div');
    barFill.className = 'category-bar-fill';
    barFill.style.width = pct + '%';
    
    barBg.appendChild(barFill);
    
    el.appendChild(header);
    el.appendChild(barBg);
    
    container.appendChild(el);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  recent.forEach(r => {
    const tr = document.createElement('tr');
    const d = new Date(r.created_at);
    
    const tdName = document.createElement('td');
    tdName.textContent = r.name;
    
    const tdCat = document.createElement('td');
    tdCat.textContent = r.category;
    
    const tdVal = document.createElement('td');
    tdVal.textContent = formatCurrency(r.value);
    
    const tdDate = document.createElement('td');
    tdDate.textContent = d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    
    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData.length) return;

  const canvas = document.getElementById('timeseries-chart');
  const wrapper = document.getElementById('chart-wrapper');
  
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

  const maxRev = Math.max(...timeseriesData.map(d => d.revenue));
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
    const y = padding.top + height - (height * (i / yTicks));
    
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + width, y);
    ctx.stroke();

    ctx.fillText(formatCurrency(val), padding.left - 10, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const idx = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const d = timeseriesData[idx];
    const x = padding.left + (width * (idx / (timeseriesData.length - 1)));
    
    const dateStr = new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    ctx.fillText(dateStr, x, padding.top + height + 10);
  }

  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (width * (i / (timeseriesData.length - 1)));
    const y = padding.top + height - (height * ((d.revenue - minRev) / (maxRev - minRev)));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

init();
