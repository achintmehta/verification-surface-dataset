import { drawChart } from './chart.js';

const API_BASE = 'http://localhost:3001/api';

async function fetchAPI(endpoint, options = {}) {
  const res = await fetch(\`\${API_BASE}\${endpoint}\`, options);
  if (!res.ok) throw new Error(\`API Error: \${res.status}\`);
  return res.json();
}

async function init() {
  try {
    // 1. Load settings and apply theme before first paint if possible
    const settings = await fetchAPI('/settings');
    document.documentElement.setAttribute('data-theme', settings.theme);

    // 2. Fetch all data
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchAPI('/summary'),
      fetchAPI('/timeseries'),
      fetchAPI('/categories'),
      fetchAPI('/recent')
    ]);

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);

    // Render chart
    const canvas = document.getElementById('timeseries-chart');
    
    const renderChart = () => {
      drawChart(canvas, timeseries);
    };
    
    renderChart();
    window.addEventListener('resize', renderChart);

    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    themeToggle.addEventListener('click', async () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      renderChart(); // Redraw chart to update colors
      
      try {
        await fetchAPI('/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: newTheme })
        });
      } catch (e) {
        console.error('Failed to save theme', e);
      }
    });

    // Show dashboard
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');

  } catch (e) {
    console.error(e);
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('error-message').textContent = e.message;
  }
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
  document.getElementById('stat-best-day').textContent = formatCurrency(summary.bestDay.revenue);
  
  const trendEl = document.getElementById('stat-trend');
  const trendVal = summary.trend;
  trendEl.textContent = \`\${trendVal > 0 ? '+' : ''}\${trendVal.toFixed(1)}%\`;
  trendEl.style.color = trendVal >= 0 ? 'green' : 'red';
}

function renderCategories(categories) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';
  if (categories.length === 0) return;
  
  const maxVal = Math.max(...categories.map(c => c.value));
  
  categories.forEach(c => {
    const pct = (c.value / maxVal) * 100;
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = \`
      <div class="category-header">
        <span class="category-name" title="\${c.name}">\${c.name}</span>
        <span class="category-value">\${formatCurrency(c.value)}</span>
      </div>
      <div class="category-bar-track">
        <div class="category-bar-fill" style="width: \${pct}%"></div>
      </div>
    \`;
    container.appendChild(div);
  });
}

function renderRecent(recent) {
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = '';
  recent.forEach(r => {
    const tr = document.createElement('tr');
    const date = new Date(r.created_at).toLocaleDateString();
    tr.innerHTML = \`
      <td>\${r.name}</td>
      <td>\${r.category}</td>
      <td>\${formatCurrency(r.value)}</td>
      <td>\${date}</td>
    \`;
    tbody.appendChild(tr);
  });
}

// Initialize
init();