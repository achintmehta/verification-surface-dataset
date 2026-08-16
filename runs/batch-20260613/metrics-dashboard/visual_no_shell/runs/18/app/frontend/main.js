let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first
    const settingsRes = await fetch('/api/settings');
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    currentTheme = settings.theme || 'light';
    applyTheme(currentTheme);
    document.documentElement.classList.remove('theme-loading');

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

    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    
    // Initial chart render
    drawChart();
    
    // Handle resize
    window.addEventListener('resize', () => {
      requestAnimationFrame(drawChart);
    });

  } catch (err) {
    console.error(err);
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('error-state').classList.remove('hidden');
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

document.getElementById('theme-toggle').addEventListener('click', async () => {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  currentTheme = newTheme;
  applyTheme(newTheme);
  drawChart(); // Redraw chart to update colors
  
  try {
    await fetch('/api/settings', {
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
  document.getElementById('stat-revenue').textContent = '$' + summary.totalRevenue.toLocaleString();
  document.getElementById('stat-best-day').textContent = summary.bestDay;
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trend7Day;
  trendEl.textContent = (trendVal > 0 ? '+' : '') + trendVal.toFixed(1) + '%';
  trendEl.style.color = trendVal >= 0 ? 'green' : 'red';
}

function renderCategories(categories) {
  const container = document.getElementById('category-breakdown');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => c.value));
  
  categories.forEach(c => {
    const pct = maxVal > 0 ? (c.value / maxVal) * 100 : 0;
    
    const row = document.createElement('div');
    row.className = 'category-row';
    
    row.innerHTML = `
      <div class="category-label-container">
        <div class="category-name" title="${c.name}">${c.name}</div>
        <div class="category-value">$${c.value.toLocaleString()}</div>
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
  
  recent.forEach(r => {
    const tr = document.createElement('tr');
    const dateStr = new Date(r.created_at).toLocaleString();
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.category}</td>
      <td>$${r.value.toLocaleString()}</td>
      <td>${dateStr}</td>
    `;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  if (!timeseriesData.length) return;
  
  const canvas = document.getElementById('timeseries-chart');
  const container = document.getElementById('chart-container');
  
  // Set actual size in memory (scaled to account for pixel ratio)
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
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
  
  const padding = { top: 20, right: 20, bottom: 30, left: 80 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxRev = Math.max(...timeseriesData.map(d => d.revenue));
  const minRev = 0; // Start Y axis at 0
  
  // Draw Y axis grid and labels
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
    ctx.fillText('$' + Math.round(val).toLocaleString(), padding.left - 10, y);
  }
  
  // Draw X axis labels (sparse)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const d = timeseriesData[index];
    const x = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    
    // Tick mark
    ctx.beginPath();
    ctx.moveTo(x, padding.top + chartHeight);
    ctx.lineTo(x, padding.top + chartHeight + 5);
    ctx.stroke();
    
    // Label
    const dateStr = d.date.substring(5); // MM-DD
    ctx.fillText(dateStr, x, padding.top + chartHeight + 10);
  }
  
  // Draw line
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * (d.revenue / maxRev));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

init();
