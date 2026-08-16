const API_URL = 'http://localhost:3000/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first to apply theme before rendering
    const settingsRes = await fetch(\`\${API_URL}/settings\`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme);

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

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
}

function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  drawChart(); // Redraw chart to update colors
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  try {
    await fetch(\`\${API_URL}/settings\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to save theme', err);
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('stat-best-day').textContent = formatCurrency(summary.bestDayRevenue);
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trendPercent;
  trendEl.textContent = \`\${trendVal > 0 ? '+' : ''}\${trendVal.toFixed(1)}%\`;
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';
  
  if (categories.length === 0) return;
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));
  
  categories.forEach(c => {
    const val = parseFloat(c.value);
    const percent = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = \`
      <div class="category-header">
        <span class="category-name" title="\${c.name}">\${c.name}</span>
        <span class="category-value">\${formatCurrency(val)}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width: \${percent}%"></div>
      </div>
    \`;
    container.appendChild(div);
  });
}

function renderRecent(recent) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';
  
  recent.forEach(item => {
    const tr = document.createElement('tr');
    const date = new Date(item.created_at).toLocaleDateString();
    tr.innerHTML = \`
      <td>\${item.name}</td>
      <td>\${item.category}</td>
      <td>\${formatCurrency(parseFloat(item.value))}</td>
      <td>\${date}</td>
    \`;
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
  
  const padding = { top: 20, right: 30, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  // Get CSS variables for colors
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  const lineColor = style.getPropertyValue('--primary-color').trim();
  
  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
  const minRev = 0; // Start y-axis at 0
  
  // Draw grid and Y-axis labels
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const yVal = minRev + (maxRev - minRev) * (i / yTicks);
    const yPos = padding.top + chartHeight - (chartHeight * (i / yTicks));
    
    // Grid line
    ctx.beginPath();
    ctx.moveTo(padding.left, yPos);
    ctx.lineTo(width - padding.right, yPos);
    ctx.stroke();
    
    // Label
    ctx.fillText(formatCurrency(yVal), padding.left - 10, yPos);
  }
  
  // Draw X-axis labels (show ~5 labels to avoid crowding)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const dataPoint = timeseriesData[index];
    if (!dataPoint) continue;
    
    const xPos = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    
    const date = new Date(dataPoint.date);
    const dateStr = \`\${date.getMonth() + 1}/\${date.getDate()}\`;
    
    ctx.fillText(dateStr, xPos, height - padding.bottom + 10);
  }
  
  // Draw line series
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  
  timeseriesData.forEach((d, i) => {
    const rev = parseFloat(d.revenue);
    const xPos = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const yPos = padding.top + chartHeight - (chartHeight * ((rev - minRev) / (maxRev - minRev)));
    
    if (i === 0) {
      ctx.moveTo(xPos, yPos);
    } else {
      ctx.lineTo(xPos, yPos);
    }
  });
  
  ctx.stroke();
}

init();
