const API_BASE = 'http://localhost:3001/api';

let currentTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', currentTheme);

let timeseriesData = [];

async function init() {
  try {
    const settingsRes = await fetch(`${API_BASE}/settings`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme);
    localStorage.setItem('theme', settings.theme);

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
  localStorage.setItem('theme', newTheme);
  drawChart();
  
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

function formatNumber(num) {
  return new Intl.NumberFormat('en-US').format(num);
}

function formatCurrency(num) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.total_visitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.total_revenue);
  document.getElementById('stat-best-day').textContent = formatCurrency(summary.best_day_revenue);
  const bestDayDate = new Date(summary.best_day_date).toLocaleDateString();
  document.getElementById('stat-best-day-date').textContent = bestDayDate;
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trend_percent;
  trendEl.textContent = `${trendVal > 0 ? '+' : ''}${trendVal.toFixed(1)}%`;
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-breakdown');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));
  
  categories.forEach(cat => {
    const val = parseFloat(cat.value);
    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const item = document.createElement('div');
    item.className = 'category-item';
    item.innerHTML = `
      <div class="category-header">
        <span class="category-name" title="${cat.name}">${cat.name}</span>
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
  
  recent.forEach(item => {
    const tr = document.createElement('tr');
    const date = new Date(item.created_at).toLocaleDateString();
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>${formatCurrency(item.value)}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData.length) return;
  
  const svg = document.getElementById('timeseries-chart');
  const wrapper = document.getElementById('timeseries-chart-wrapper');
  const width = wrapper.clientWidth;
  const height = wrapper.clientHeight;
  
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = '';
  
  const margin = { top: 20, right: 20, bottom: 30, left: 60 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  
  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
  const minRev = 0;
  
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();
  
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minRev + (maxRev - minRev) * (i / yTicks);
    const y = margin.top + innerHeight - (i / yTicks) * innerHeight;
    
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('y1', y);
    line.setAttribute('x2', width - margin.right);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', gridColor);
    svg.appendChild(line);
    
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', margin.left - 10);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', textColor);
    text.setAttribute('font-size', '12px');
    text.textContent = formatCurrency(val);
    svg.appendChild(text);
  }
  
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const idx = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const d = timeseriesData[idx];
    const x = margin.left + (idx / (timeseriesData.length - 1)) * innerWidth;
    
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - 5);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', textColor);
    text.setAttribute('font-size', '12px');
    const dateObj = new Date(d.date);
    text.textContent = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
    svg.appendChild(text);
  }
  
  const points = timeseriesData.map((d, i) => {
    const x = margin.left + (i / (timeseriesData.length - 1)) * innerWidth;
    const y = margin.top + innerHeight - (parseFloat(d.revenue) / maxRev) * innerHeight;
    return `${x},${y}`;
  }).join(' ');
  
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', points);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', lineColor);
  polyline.setAttribute('stroke-width', '2');
  svg.appendChild(polyline);
}

init();
