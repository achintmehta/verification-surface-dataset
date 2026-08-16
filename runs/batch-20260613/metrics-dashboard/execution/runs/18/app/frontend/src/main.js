import { fetchSummary, fetchTimeseries, fetchCategories, fetchRecent, fetchSettings, updateSettings } from './api.js';
import { drawChart } from './chart.js';

let timeseriesData = [];

async function init() {
  try {
    // Load settings first to apply theme before paint
    const settings = await fetchSettings();
    document.documentElement.setAttribute('data-theme', settings.theme);
    
    // Load all data
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent()
    ]);
    
    timeseriesData = timeseries;
    
    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    
    // Show dashboard
    document.getElementById('dashboard').classList.remove('hidden');
    
    // Draw chart
    const canvas = document.getElementById('timeseries-chart');
    drawChart(canvas, timeseriesData);
    
    // Handle resize
    window.addEventListener('resize', () => {
      drawChart(canvas, timeseriesData);
    });
    
    // Handle theme toggle
    document.getElementById('theme-toggle').addEventListener('click', async () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      
      // Redraw chart to update colors
      drawChart(canvas, timeseriesData);
      
      // Persist
      try {
        await updateSettings({ theme: newTheme });
      } catch (err) {
        console.error('Failed to save theme', err);
      }
    });
    
  } catch (err) {
    console.error(err);
    document.getElementById('error-state').classList.remove('hidden');
  }
}

function renderSummary(summary) {
  document.getElementById('stat-visitors').textContent = summary.totalVisitors.toLocaleString();
  document.getElementById('stat-revenue').textContent = '$' + Math.round(summary.totalRevenue).toLocaleString();
  document.getElementById('stat-best-day').textContent = '$' + Math.round(summary.bestDayRevenue).toLocaleString();
  
  const trendEl = document.getElementById('stat-trend');
  const trend = summary.trendPercentage;
  trendEl.textContent = (trend > 0 ? '+' : '') + trend.toFixed(1) + '%';
  trendEl.style.color = trend >= 0 ? 'green' : 'red';
}

function renderCategories(categories) {
  const container = document.getElementById('category-bars');
  container.innerHTML = '';
  
  if (!categories || categories.length === 0) return;
  
  const maxVal = Math.max(...categories.map(c => parseFloat(c.value)));
  
  categories.forEach(c => {
    const val = parseFloat(c.value);
    const pct = (val / maxVal) * 100;
    
    const row = document.createElement('div');
    row.className = 'bar-row';
    
    const labelContainer = document.createElement('div');
    labelContainer.className = 'bar-label-container';
    
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = c.name;
    label.title = c.name; // Tooltip for truncated text
    
    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = '$' + Math.round(val).toLocaleString();
    
    labelContainer.appendChild(label);
    labelContainer.appendChild(value);
    
    const track = document.createElement('div');
    track.className = 'bar-track';
    
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${pct}%`;
    
    track.appendChild(fill);
    
    row.appendChild(labelContainer);
    row.appendChild(track);
    
    container.appendChild(row);
  });
}

function renderRecent(recent) {
  const tbody = document.getElementById('recent-items-body');
  tbody.innerHTML = '';
  
  recent.forEach(item => {
    const tr = document.createElement('tr');
    
    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    
    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;
    
    const tdVal = document.createElement('td');
    tdVal.textContent = '$' + parseFloat(item.value).toLocaleString();
    
    const tdDate = document.createElement('td');
    tdDate.textContent = new Date(item.created_at).toLocaleString();
    
    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    
    tbody.appendChild(tr);
  });
}

init();