const API_BASE = 'http://localhost:3001/api';

let currentTheme = 'light';
let resizeTimeout = null;

async function fetchWithError(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  const errorBanner = document.getElementById('error-banner');
  
  try {
    const [summary, timeseries, categories, recent, settings] = await Promise.all([
      fetchWithError(`${API_BASE}/summary`),
      fetchWithError(`${API_BASE}/timeseries`),
      fetchWithError(`${API_BASE}/categories`),
      fetchWithError(`${API_BASE}/recent`),
      fetchWithError(`${API_BASE}/settings`)
    ]);

    // Apply theme from server
    applyTheme(settings.theme);

    // Render all sections
    renderStats(summary);
    renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecentTable(recent);

    errorBanner.style.display = 'none';
    return true;
  } catch (err) {
    console.error('Failed to load data:', err);
    errorBanner.style.display = 'block';
    return false;
  }
}

function renderStats(summary) {
  document.getElementById('total-visitors').textContent = 
    summary.totalVisitors.toLocaleString();
  
  document.getElementById('total-revenue').textContent = 
    '$' + summary.totalRevenue.toLocaleString();
  
  document.getElementById('best-day').textContent = 
    summary.bestDay ? new Date(summary.bestDay).toLocaleDateString() : 'N/A';
  
  const trendEl = document.getElementById('seven-day-trend');
  const trend = summary.sevenDayTrend;
  trendEl.textContent = (trend >= 0 ? '+' : '') + trend + '%';
  trendEl.style.color = trend >= 0 ? 'var(--success)' : '#ef4444';
}

function renderTimeseries(data) {
  const canvas = document.getElementById('timeseries-chart');
  const container = document.getElementById('timeseries-container');
  
  if (!data || data.length === 0) return;

  function drawChart() {
    const ctx = canvas.getContext('2d', { alpha: true });
    const rect = container.getBoundingClientRect();
    
    // Set canvas size to match container
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = 300 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '300px';
    
    ctx.scale(dpr, dpr);
    
    const width = rect.width;
    const height = 300;
    const padding = { top: 20, right: 40, bottom: 40, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.clearRect(0, 0, width, height);

    // Data
    const visitors = data.map(d => d.visitors);
    const maxVisitors = Math.max(...visitors);
    const minVisitors = Math.min(...visitors);
    const range = maxVisitors - minVisitors || 1;

    // Draw gridlines
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim() || '#e2e8f0';
    ctx.lineWidth = 1;
    
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartHeight * i / 4);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    // Draw axes
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#64748b';
    ctx.lineWidth = 1.5;
    
    // Y axis
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.stroke();
    
    // X axis
    ctx.beginPath();
    ctx.moveTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Y ticks and labels
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#64748b';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    
    for (let i = 0; i <= 4; i++) {
      const value = Math.round(minVisitors + (range * (4 - i) / 4));
      const y = padding.top + (chartHeight * i / 4);
      ctx.fillText(value.toLocaleString(), padding.left - 8, y);
    }

    // X ticks (every 5 days)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    
    data.forEach((d, i) => {
      if (i % 5 === 0 || i === data.length - 1) {
        const x = padding.left + (chartWidth * i / (data.length - 1));
        const date = new Date(d.date);
        ctx.fillText(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), x, height - padding.bottom + 8);
        
        // Tick mark
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-axis').trim() || '#64748b';
        ctx.beginPath();
        ctx.moveTo(x, height - padding.bottom);
        ctx.lineTo(x, height - padding.bottom + 4);
        ctx.stroke();
      }
    });

    // Draw line
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || '#3b82f6';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    
    data.forEach((d, i) => {
      const x = padding.left + (chartWidth * i / (data.length - 1));
      const y = padding.top + chartHeight * (1 - (d.visitors - minVisitors) / range);
      
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw points
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || '#3b82f6';
    data.forEach((d, i) => {
      const x = padding.left + (chartWidth * i / (data.length - 1));
      const y = padding.top + chartHeight * (1 - (d.visitors - minVisitors) / range);
      
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Store draw function for resize
  canvas._drawChart = drawChart;
  
  // Initial draw
  drawChart();
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  if (!categories || categories.length === 0) return;

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';

    const header = document.createElement('div');
    header.className = 'category-header';

    const name = document.createElement('div');
    name.className = 'category-name';
    name.textContent = cat.name;
    name.title = cat.name; // full name on hover

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = '$' + cat.value.toLocaleString();

    header.appendChild(name);
    header.appendChild(value);

    const barContainer = document.createElement('div');
    barContainer.className = 'category-bar-container';

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    bar.style.width = ((cat.value / maxValue) * 100) + '%';

    barContainer.appendChild(bar);
    item.appendChild(header);
    item.appendChild(barContainer);
    container.appendChild(item);
  });
}

function renderRecentTable(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  if (!items || items.length === 0) return;

  items.forEach(item => {
    const row = document.createElement('tr');
    
    const date = new Date(item.created_at);
    const dateStr = date.toLocaleDateString();

    row.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>$${item.value.toLocaleString()}</td>
      <td>${dateStr}</td>
    `;
    
    tbody.appendChild(row);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  
  // Redraw chart if exists
  const canvas = document.getElementById('timeseries-chart');
  if (canvas && canvas._drawChart) {
    setTimeout(() => canvas._drawChart(), 50);
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  try {
    await fetchWithError(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
    
    applyTheme(newTheme);
  } catch (err) {
    console.error('Failed to save theme:', err);
    // Apply locally anyway
    applyTheme(newTheme);
  }
}

function setupResizeHandler() {
  const canvas = document.getElementById('timeseries-chart');
  
  function handleResize() {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (canvas && canvas._drawChart) {
        canvas._drawChart();
      }
    }, 100);
  }
  
  window.addEventListener('resize', handleResize);
}

function setupThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', toggleTheme);
}

async function init() {
  setupThemeToggle();
  setupResizeHandler();
  
  // Load data and apply persisted theme
  await loadData();
  
  // Ensure chart redraws after initial load
  setTimeout(() => {
    const canvas = document.getElementById('timeseries-chart');
    if (canvas && canvas._drawChart) {
      canvas._drawChart();
    }
  }, 100);
}

init();