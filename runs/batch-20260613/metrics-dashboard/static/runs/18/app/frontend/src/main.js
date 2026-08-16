import { fetchSummary, fetchTimeseries, fetchCategories, fetchRecent, fetchSettings, updateSettings } from './api.js';
import { TimeseriesChart } from './chart.js';

let currentTheme = 'light';
let chartInstance = null;

async function init() {
  try {
    // Fetch settings first to apply theme
    const settings = await fetchSettings();
    currentTheme = settings.theme || 'light';
    applyTheme(currentTheme);

    // Fetch all data
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent()
    ]);

    renderSummary(summary);
    
    chartInstance = new TimeseriesChart('timeseries-chart');
    chartInstance.setData(timeseries);

    renderCategories(categories);
    renderRecent(recent);

    document.getElementById('dashboard').classList.remove('hidden');
  } catch (err) {
    console.error(err);
    document.getElementById('error-state').classList.remove('hidden');
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (chartInstance) {
    chartInstance.draw();
  }
}

document.getElementById('theme-toggle').addEventListener('click', async () => {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(currentTheme);
  try {
    await updateSettings({ theme: currentTheme });
  } catch (err) {
    console.error('Failed to save theme', err);
  }
});

function renderSummary(summary) {
  document.querySelector('#card-visitors .value').textContent = summary.totalVisitors.toLocaleString();
  document.querySelector('#card-revenue .value').textContent = '$' + summary.totalRevenue.toLocaleString();
  
  const bestDate = new Date(summary.bestDay).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  document.querySelector('#card-best-day .value').textContent = bestDate;
  
  const trendEl = document.querySelector('#card-trend .value');
  const trendVal = summary.trendPercent;
  trendEl.textContent = (trendVal > 0 ? '+' : '') + trendVal.toFixed(1) + '%';
  trendEl.style.color = trendVal >= 0 ? '#10b981' : '#ef4444';
}

function renderCategories(categories) {
  const container = document.getElementById('category-breakdown');
  container.innerHTML = '';
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));

  categories.forEach(c => {
    const val = parseFloat(c.value);
    const pct = (val / maxVal) * 100;
    
    const item = document.createElement('div');
    item.className = 'category-item';
    
    item.innerHTML = \`
      <div class="category-label-row">
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
    const dateStr = new Date(r.created_at).toLocaleString(undefined, { 
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
    });
    
    tr.innerHTML = \`
      <td>\${r.name}</td>
      <td>\${r.category}</td>
      <td>$\${parseFloat(r.value).toLocaleString()}</td>
      <td>\${dateStr}</td>
    \`;
    
    tbody.appendChild(tr);
  });
}

init();
