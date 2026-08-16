import {
  getSummary,
  getTimeseries,
  getCategories,
  getRecent,
  getSettings,
  putSettings,
  type SummaryData,
  type TimeseriesPoint,
  type CategoryData,
  type RecentItem,
} from './api';
import { drawChart, redrawChart } from './chart';

// ===== DOM References =====
const loadingEl = document.getElementById('loading-state')!;
const errorEl = document.getElementById('error-state')!;
const gridEl = document.getElementById('dashboard-grid')!;
const themeToggle = document.getElementById('theme-toggle')!;
const themeIcon = themeToggle.querySelector('.theme-icon')!;

// Stat card values
const statVisitors = document.getElementById('stat-visitors')!;
const statRevenue = document.getElementById('stat-revenue')!;
const statBestDay = document.getElementById('stat-best-day')!;
const statBestDayDate = document.getElementById('stat-best-day-date')!;
const statTrend = document.getElementById('stat-trend')!;

// Chart
const chartCanvas = document.getElementById('timeseries-chart') as HTMLCanvasElement;

// Categories
const categoriesList = document.getElementById('categories-list')!;

// Recent table body
const recentTbody = document.getElementById('recent-tbody')!;

// ===== Theme Management =====
let currentTheme: 'light' | 'dark' = 'light';

function applyTheme(theme: 'light' | 'dark'): void {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
}

themeToggle.addEventListener('click', async () => {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  // Redraw chart with new theme colors
  redrawChart(chartCanvas);
  // Persist to server
  try {
    await putSettings({ theme: newTheme });
  } catch (_err) {
    // Silently fail; the UI has already updated
    console.warn('Failed to persist theme setting');
  }
});

// ===== Rendering Functions =====

function renderSummary(data: SummaryData): void {
  statVisitors.textContent = data.totalVisitors.toLocaleString();
  statRevenue.textContent = '$' + data.totalRevenue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (data.bestDay) {
    statBestDay.textContent = data.bestDay.visitors.toLocaleString() + ' visitors';
    const d = new Date(data.bestDay.date);
    statBestDayDate.textContent = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  const trendVal = data.sevenDayTrend;
  const sign = trendVal >= 0 ? '+' : '';
  const arrow = trendVal >= 0 ? '↑' : '↓';
  statTrend.textContent = `${arrow} ${sign}${trendVal}%`;
  statTrend.className = 'stat-value ' + (trendVal >= 0 ? 'trend-up' : 'trend-down');
}

function renderTimeseries(data: TimeseriesPoint[]): void {
  drawChart(chartCanvas, data);
}

function renderCategories(data: CategoryData[]): void {
  const maxValue = Math.max(...data.map(c => c.value));

  categoriesList.innerHTML = data.map(cat => {
    const pct = maxValue > 0 ? (cat.value / maxValue) * 100 : 0;
    const formattedValue = cat.value.toLocaleString();
    return `
      <div class="category-item">
        <div class="category-header">
          <span class="category-name" title="${escapeHTML(cat.name)}">${escapeHTML(cat.name)}</span>
          <span class="category-value">${formattedValue}</span>
        </div>
        <div class="category-bar-bg">
          <div class="category-bar-fill" style="width: ${pct.toFixed(1)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderRecent(data: RecentItem[]): void {
  recentTbody.innerHTML = data.map(item => {
    const date = new Date(item.createdAt);
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    return `
      <tr>
        <td title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</td>
        <td title="${escapeHTML(item.category)}">${escapeHTML(item.category)}</td>
        <td class="num-col">$${item.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td>${dateStr}</td>
      </tr>
    `;
  }).join('');
}

function escapeHTML(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Initialization =====

async function init(): Promise<void> {
  // First, try to load and apply persisted theme before any data fetch
  try {
    const settings = await getSettings();
    applyTheme(settings.theme);
  } catch (_err) {
    // Use default light theme if settings can't be fetched
    applyTheme('light');
  }

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);

    // Render everything
    renderSummary(summary);
    renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecent(recent);

    // Show dashboard, hide loading
    loadingEl.style.display = 'none';
    errorEl.style.display = 'none';
    gridEl.style.display = 'block';
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    gridEl.style.display = 'none';
  }
}

init();
