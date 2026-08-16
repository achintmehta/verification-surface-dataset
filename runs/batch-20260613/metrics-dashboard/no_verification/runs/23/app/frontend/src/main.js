import { getSummary, getTimeseries, getCategories, getRecent, getSettings } from './api.js';
import { applyTheme, setupToggle, getCurrentTheme } from './theme.js';
import { drawTimeseriesChart, redrawChart } from './chart.js';
import { drawCategoryBars } from './categoryChart.js';

async function init() {
  const errorBanner = document.getElementById('error-banner');
  const loadingSpinner = document.getElementById('loading-spinner');
  const dashboardContent = document.getElementById('dashboard-content');

  // 1. Load theme first, apply before paint
  try {
    const settings = await getSettings();
    applyTheme(settings.theme || 'light');
  } catch (e) {
    // Default to light if backend unreachable
    applyTheme('light');
  }

  // 2. Setup toggle — redraws chart on theme change
  setupToggle((newTheme) => {
    // Redraw chart with new colors
    redrawChart();
  });

  // 3. Load all data
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);

    // Hide loading, show content
    loadingSpinner.style.display = 'none';
    dashboardContent.style.display = 'block';

    // Render stat cards
    renderSummary(summary);

    // Render time-series chart
    const tsContainer = document.getElementById('timeseries-container');
    drawTimeseriesChart(tsContainer, timeseries);

    // Render category bars
    const catContainer = document.getElementById('category-bars');
    drawCategoryBars(catContainer, categories);

    // Render recent items table
    renderRecentTable(recent);

  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    loadingSpinner.style.display = 'none';
    errorBanner.style.display = 'block';
    dashboardContent.style.display = 'none';
  }
}

function renderSummary(data) {
  // Total Visitors
  const valVisitors = document.getElementById('val-visitors');
  valVisitors.textContent = Number(data.totalVisitors).toLocaleString();

  // Total Revenue
  const valRevenue = document.getElementById('val-revenue');
  valRevenue.textContent = '$' + Number(data.totalRevenue).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  // Best Day
  const valBestday = document.getElementById('val-bestday');
  const valBestdayDate = document.getElementById('val-bestday-date');
  if (data.bestDay) {
    valBestday.textContent = Number(data.bestDay.visitors).toLocaleString() + ' visitors';
    const d = new Date(data.bestDay.date);
    valBestdayDate.textContent = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  // 7-Day Trend
  const valTrend = document.getElementById('val-trend');
  const sign = data.trend >= 0 ? '+' : '';
  valTrend.textContent = `${sign}${data.trend}%`;
  valTrend.classList.add(data.trend >= 0 ? 'trend-positive' : 'trend-negative');
}

function renderRecentTable(data) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  for (const item of data) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;

    const tdCategory = document.createElement('td');
    tdCategory.className = 'cell-category';
    tdCategory.textContent = item.category;
    tdCategory.title = item.category;

    const tdValue = document.createElement('td');
    tdValue.textContent = '$' + Number(item.value).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const tdDate = document.createElement('td');
    const d = new Date(item.created_at);
    tdDate.textContent = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

    tr.appendChild(tdName);
    tr.appendChild(tdCategory);
    tr.appendChild(tdValue);
    tr.appendChild(tdDate);
    tbody.appendChild(tr);
  }
}

// Boot
init();
