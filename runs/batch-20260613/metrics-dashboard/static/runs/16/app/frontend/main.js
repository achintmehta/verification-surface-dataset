const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // Fetch settings first
    const settingsRes = await fetch(\`\${API_BASE}/settings\`);
    if (!settingsRes.ok) throw new Error('Failed to fetch settings');
    const settings = await settingsRes.json();
    setTheme(settings.theme, false);
    document.body.style.visibility = 'visible';

    // Fetch all data
    const [summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(\`\${API_BASE}/summary\`),
      fetch(\`\${API_BASE}/timeseries\`),
      fetch(\`\${API_BASE}/categories\`),
      fetch(\`\${API_BASE}/recent\`)
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
    document.body.style.visibility = 'visible';
  }
}

function setTheme(theme, persist = true) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) {
    fetch(\`\${API_BASE}/settings\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    }).catch(console.error);
  }
  // Redraw chart to update colors
  if (timeseriesData.length > 0) {
    drawChart();
  }
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  setTheme(currentTheme === 'light' ? 'dark' : 'light');
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
  document.getElementById('stat-best-day').textContent = formatCurrency(summary.bestDayRevenue);
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trendPercent;
  const sign = trendVal > 0 ? '+' : '';
  trendEl.textContent = \`\${sign}\${trendVal.toFixed(1)}%\`;
  if (trendVal > 0) {
    trendEl.className = 'stat-value trend-positive';
  } else if (trendVal < 0) {
    trendEl.className = 'stat-value trend-negative';
  } else {
    trendEl.className = 'stat-value';
  }
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';
  
  if (categories.length === 0) return;
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));
  
  categories.forEach(c => {
    const val = parseFloat(c.value);
    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const row = document.createElement('div');
    row.className = 'bar-row';
    
    const labelContainer = document.createElement('div');
    labelContainer.className = 'bar-label-container';
    
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = c.name;
    label.title = c.name;
    
    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = formatCurrency(val);
    
    labelContainer.appendChild(label);
    labelContainer.appendChild(value);
    
    const track = document.createElement('div');
    track.className = 'bar-track';
    
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = \`\${pct}%\`;
    
    track.appendChild(fill);
    
    row.appendChild(labelContainer);
    row.appendChild(track);
    
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
    const d = new Date(item.created_at);
    tdDate.textContent = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    
    tbody.appendChild(tr);
  });
}

function drawChart() {
  const canvas = document.getElementById('timeseries-chart');
  const wrapper = document.getElementById('timeseries-wrapper');
  if (!canvas || !wrapper || timeseriesData.length === 0) return;

  // Set actual canvas size to match display size
  const rect = wrapper.getBoundingClientRect();
  // Handle high DPI displays
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
  
  const padding = { top: 20, right: 20, bottom: 30, left: 70 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxRev = Math.max(...timeseriesData.map(d => parseFloat(d.revenue)));
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
    const y = height - padding.bottom + 10;
    
    const dateStr = new Date(dataPoint.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    ctx.fillText(dateStr, x, y);
  }
  
  // Draw line
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  timeseriesData.forEach((d, i) => {
    const rev = parseFloat(d.revenue);
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * ((rev - minRev) / (maxRev - minRev)));
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.stroke();
}

init();
