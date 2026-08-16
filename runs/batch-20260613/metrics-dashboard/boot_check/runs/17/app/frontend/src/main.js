const API_URL = 'http://localhost:3001/api';

let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before first paint if possible
    const settingsRes = await fetch(\`\${API_URL}/settings\`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const { theme } = await settingsRes.json();
    document.documentElement.setAttribute('data-theme', theme);

    // Fetch all data
    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(\`\${API_URL}/summary\`),
      fetch(\`\${API_URL}/timeseries\`),
      fetch(\`\${API_URL}/categories\`),
      fetch(\`\${API_URL}/recent\`)
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

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('stat-revenue').textContent = '$' + summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('stat-best-day').textContent = '$' + summary.bestDay.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('stat-best-day-date').textContent = new Date(summary.bestDay.date).toLocaleDateString();
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = parseFloat(summary.trend);
  trendEl.textContent = (trendVal > 0 ? '+' : '') + trendVal + '%';
  trendEl.style.color = trendVal >= 0 ? 'green' : 'red';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-breakdown');
  container.innerHTML = '';
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));

  categories.forEach(c => {
    const val = parseFloat(c.value);
    const pct = maxVal === 0 ? 0 : (val / maxVal) * 100;
    
    const item = document.createElement('div');
    item.className = 'category-item';
    
    item.innerHTML = \`
      <div class="category-header">
        <span class="category-name" title="\${c.name}">\${c.name}</span>
        <span class="category-value">$\${val.toLocaleString()}</span>
      </div>
      <div class="category-bar-bg">
        <div class="category-bar-fill" style="width: \${pct}%"></div>
      </div>
    \`;
    container.appendChild(item);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  recent.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${r.name}</td>
      <td>\${r.category}</td>
      <td>$\${parseFloat(r.value).toLocaleString()}</td>
      <td>\${new Date(r.created_at).toLocaleDateString()}</td>
    \`;
    tbody.appendChild(tr);
  });
}

function drawChart() {
  const canvas = document.getElementById('timeseries-chart');
  const wrapper = document.getElementById('timeseries-chart-wrapper');
  
  // Set actual size in memory (scaled to account for extra pixel density)
  const rect = wrapper.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  
  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  
  const width = rect.width;
  const height = rect.height;
  
  ctx.clearRect(0, 0, width, height);
  
  if (timeseriesData.length === 0) return;

  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--chart-line').trim();

  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
  const minRev = 0;

  // Draw grid and Y-axis labels
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minRev + (maxRev - minRev) * (i / yTicks);
    const y = padding.top + chartHeight - (i / yTicks) * chartHeight;
    
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    
    ctx.fillText('$' + Math.round(val).toLocaleString(), padding.left - 10, y);
  }

  // Draw X-axis labels (sparse)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = width < 400 ? 3 : 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const d = timeseriesData[index];
    if (!d) continue;
    const x = padding.left + (index / (timeseriesData.length - 1)) * chartWidth;
    
    const dateStr = new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    ctx.fillText(dateStr, x, padding.top + chartHeight + 10);
  }

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  timeseriesData.forEach((d, i) => {
    const x = padding.left + (i / (timeseriesData.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - (parseFloat(d.revenue) / maxRev) * chartHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

document.getElementById('theme-toggle').addEventListener('click', async () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  document.documentElement.setAttribute('data-theme', newTheme);
  drawChart(); // Redraw chart to update colors
  
  try {
    await fetch(\`\${API_URL}/settings\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to save theme', err);
  }
});

init();
