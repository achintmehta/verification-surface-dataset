const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    const settingsRes = await fetch(`${API_BASE}/settings`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme, false);
    document.body.classList.add('ready');

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
    window.addEventListener('resize', drawChart);

  } catch (err) {
    console.error(err);
    document.body.classList.add('ready');
    document.getElementById('error-state').classList.remove('hidden');
  }
}

function setTheme(theme, persist = true) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) {
    fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    }).catch(console.error);
  }
  if (timeseriesData.length > 0) {
    drawChart();
  }
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  setTheme(currentTheme === 'light' ? 'dark' : 'light');
});

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('stat-revenue').textContent = '$' + summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('stat-best-day').textContent = '$' + summary.bestDayRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('stat-trend').textContent = summary.trend + '%';
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));

  categories.forEach(cat => {
    const val = parseFloat(cat.value);
    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${cat.name}">${cat.name}</span>
        <span class="category-value">${val.toLocaleString()}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width: ${pct}%"></div>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderRecent(recent) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';
  recent.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>${parseFloat(item.value).toLocaleString()}</td>
      <td>${new Date(item.created_at).toLocaleDateString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  const container = document.getElementById('chart-container');
  const canvas = document.getElementById('timeseries-chart');
  if (!canvas || timeseriesData.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);

  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
  const minRev = 0;

  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();

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

    ctx.fillText(val.toLocaleString(undefined, { maximumFractionDigits: 0 }), padding.left - 10, y);
  }

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

  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  
  timeseriesData.forEach((d, i) => {
    const val = parseFloat(d.revenue);
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * ((val - minRev) / (maxRev - minRev)));
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
}

init();