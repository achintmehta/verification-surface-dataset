import { fetchSummary, fetchTimeseries, fetchCategories, fetchRecent, fetchSettings, updateSettings } from './api.js';
import { TimeseriesChart } from './chart.js';

let currentTheme = localStorage.getItem('theme-cache') || 'light';
applyTheme(currentTheme);
let chartInstance = null;

async function init() {
  try {
    // 1. Fetch and apply settings
    const settings = await fetchSettings();
    if (settings.theme && settings.theme !== currentTheme) {
      currentTheme = settings.theme;
      applyTheme(currentTheme);
      localStorage.setItem('theme-cache', currentTheme);
    }

    // 2. Fetch data
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent()
    ]);

    // 3. Render UI
    renderSummary(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderRecent(recent);

    document.getElementById('dashboard').classList.remove('hidden');
  } catch (err) {
    console.error(err);
    document.getElementById('error-state').classList.remove('hidden');
  }

  // Setup theme toggle
  document.getElementById('theme-toggle').addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    currentTheme = newTheme;
    localStorage.setItem('theme-cache', currentTheme);
    
    // Redraw chart to pick up new CSS variables
    if (chartInstance) {
      chartInstance.draw();
    }

    try {
      await updateSettings({ theme: newTheme });
    } catch (err) {
      console.error('Failed to save theme preference', err);
    }
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function formatNumber(val) {
  return new Intl.NumberFormat('en-US').format(val);
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = formatNumber(summary.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(summary.totalRevenue);
  
  const bestDayDate = new Date(summary.bestDay.date).toLocaleDateString();
  document.getElementById('stat-best-day').textContent = \`\${formatCurrency(summary.bestDay.revenue)} (\${bestDayDate})\`;
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = parseFloat(summary.trendPercent);
  trendEl.textContent = \`\${trendVal > 0 ? '+' : ''}\${trendVal}%\`;
  trendEl.style.color = trendVal >= 0 ? 'green' : 'red';
}

function renderChart(timeseries) {
  chartInstance = new TimeseriesChart('timeseries-chart');
  chartInstance.setData(timeseries);
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));

  categories.forEach(cat => {
    const val = parseFloat(cat.value);
    const percent = (val / maxVal) * 100;

    const item = document.createElement('div');
    item.className = 'category-item';

    item.innerHTML = \`
      <div class="category-header">
        <div class="category-name" title="\${cat.name}">\${cat.name}</div>
        <div class="category-value">\${formatCurrency(val)}</div>
      </div>
      <div class="category-bar-bg">
        <div class="category-bar-fill" style="width: \${percent}%"></div>
      </div>
    \`;

    container.appendChild(item);
  });
}

function renderRecent(recent) {
  const tbody = document.getElementById('recent-items-tbody');
  tbody.innerHTML = '';

  recent.forEach(item => {
    const tr = document.createElement('tr');
    
    const dateStr = new Date(item.created_at).toLocaleString();
    
    tr.innerHTML = \`
      <td>\${item.name}</td>
      <td>\${item.category}</td>
      <td>\${formatCurrency(parseFloat(item.value))}</td>
      <td>\${dateStr}</td>
    \`;
    
    tbody.appendChild(tr);
  });
}

init();
