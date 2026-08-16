const API_BASE = '/api';

let currentTheme = 'light';
let timeseriesData = [];

async function init() {
  try {
    // 1. Fetch settings to apply theme before first paint if possible
    // Actually, we might want to fetch settings first, but to avoid blocking, we can fetch all in parallel
    const [settingsRes, summaryRes, timeseriesRes, categoriesRes, recentRes] = await Promise.all([
      fetch(\`\${API_BASE}/settings\`),
      fetch(\`\${API_BASE}/summary\`),
      fetch(\`\${API_BASE}/timeseries\`),
      fetch(\`\${API_BASE}/categories\`),
      fetch(\`\${API_BASE}/recent\`)
    ]);

    if (!settingsRes.ok || !summaryRes.ok || !timeseriesRes.ok || !categoriesRes.ok || !recentRes.ok) {
      throw new Error('API response not ok');
    }

    const settings = await settingsRes.json();
    const summary = await summaryRes.json();
    timeseriesData = await timeseriesRes.json();
    const categories = await categoriesRes.json();
    const recent = await recentRes.json();

    // Apply theme
    setTheme(settings.theme);
    document.body.style.visibility = 'visible';

    // Render Summary
    document.getElementById('stat-visitors').textContent = Number(summary.total_visitors).toLocaleString();
    document.getElementById('stat-revenue').textContent = '$' + Number(summary.total_revenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('stat-best-day').textContent = '$' + Number(summary.best_day_revenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    const trendVal = Number(summary.trend_percent);
    const trendEl = document.getElementById('stat-trend');
    trendEl.textContent = (trendVal > 0 ? '+' : '') + trendVal.toFixed(1) + '%';
    trendEl.style.color = trendVal >= 0 ? 'green' : 'red';

    // Render Categories
    renderCategories(categories);

    // Render Recent Items
    renderRecent(recent);

    // Render Chart
    renderChart();

    // Show dashboard
    document.getElementById('dashboard').classList.remove('hidden');

  } catch (err) {
    console.error(err);
    document.body.style.visibility = 'visible';
    document.getElementById('error-state').classList.remove('hidden');
  }
}

function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  renderChart(); // Redraw chart with new theme colors
}

document.getElementById('theme-toggle').addEventListener('click', async () => {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  try {
    await fetch(\`\${API_BASE}/settings\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.error('Failed to save theme', err);
  }
});

function renderCategories(categories) {
  const container = document.getElementById('category-breakdown');
  container.innerHTML = '';
  
  if (categories.length === 0) return;
  
  const maxVal = Math.max(...categories.map(c => Number(c.value)));

  categories.forEach(cat => {
    const val = Number(cat.value);
    const percent = maxVal > 0 ? (val / maxVal) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'bar-row';

    const labelContainer = document.createElement('div');
    labelContainer.className = 'bar-label-container';

    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = cat.name;
    label.title = cat.name; // Tooltip for truncated text

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = val.toLocaleString();

    labelContainer.appendChild(label);
    labelContainer.appendChild(value);

    const track = document.createElement('div');
    track.className = 'bar-track';

    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = \`\${percent}%\`;

    track.appendChild(fill);

    row.appendChild(labelContainer);
    row.appendChild(track);

    container.appendChild(row);
  });
}

function renderRecent(items) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';

  items.forEach(item => {
    const tr = document.createElement('tr');
    
    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    
    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;
    
    const tdVal = document.createElement('td');
    tdVal.textContent = Number(item.value).toLocaleString();
    
    const tdDate = document.createElement('td');
    tdDate.textContent = new Date(item.created_at).toLocaleDateString();

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
  const wrapper = document.getElementById('timeseries-chart-wrapper');
  
  // Set actual canvas size to match display size for sharp rendering
  const rect = wrapper.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  
  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);

  // Get theme colors
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();

  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxVisitors = Math.max(...timeseriesData.map(d => Number(d.visitors)));
  const minVisitors = 0; // Start y-axis at 0

  // Draw Grid and Y-axis labels
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minVisitors + (maxVisitors - minVisitors) * (i / yTicks);
    const y = padding.top + chartHeight - (chartHeight * (i / yTicks));
    
    // Grid line
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Label
    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 10, y);
  }

  // Draw X-axis labels (sparse to avoid overlap)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((timeseriesData.length - 1) * (i / xTicks));
    const dataPoint = timeseriesData[index];
    if (!dataPoint) continue;

    const x = padding.left + (chartWidth * (index / (timeseriesData.length - 1)));
    const date = new Date(dataPoint.date);
    const dateStr = \`\${date.getMonth() + 1}/\${date.getDate()}\`;

    ctx.fillText(dateStr, x, height - padding.bottom + 10);
  }

  // Draw Line
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();

  timeseriesData.forEach((d, i) => {
    const val = Number(d.visitors);
    const x = padding.left + (chartWidth * (i / (timeseriesData.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * ((val - minVisitors) / (maxVisitors - minVisitors)));

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
}

// Handle resize
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    renderChart();
  }, 100);
});

// Initialize
init();