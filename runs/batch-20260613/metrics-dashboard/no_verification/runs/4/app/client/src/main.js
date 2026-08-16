import { fetchSummary, fetchTimeseries, fetchCategories, fetchRecent, fetchSettings, putSettings } from './api.js';
import { renderChart } from './chart.js';
import { formatNumber, formatCurrency, formatDate, formatPercent } from './format.js';

// ── State ─────────────────────────────────────────────────────────────────
let currentTheme = 'light';
let timeseriesData = [];
let chartResizeObserver = null;

// ── DOM refs ──────────────────────────────────────────────────────────────
const loadingOverlay  = document.getElementById('loading-overlay');
const errorBanner     = document.getElementById('error-banner');
const errorMessage    = document.getElementById('error-message');
const themeToggle     = document.getElementById('theme-toggle');

// Stat card value elements
const statVisitors    = document.getElementById('stat-visitors');
const statVisitorsSub = document.getElementById('stat-visitors-sub');
const statRevenue     = document.getElementById('stat-revenue');
const statRevenueSub  = document.getElementById('stat-revenue-sub');
const statBestday     = document.getElementById('stat-bestday');
const statBestdaySub  = document.getElementById('stat-bestday-sub');
const statTrend       = document.getElementById('stat-trend');
const statTrendSub    = document.getElementById('stat-trend-sub');

const categoriesList  = document.getElementById('categories-list');
const recentTbody     = document.getElementById('recent-tbody');
const chartContainer  = document.getElementById('chart-container');

// ── Helpers ───────────────────────────────────────────────────────────────
function showError(msg) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
}

function hideError() {
  errorBanner.hidden = true;
}

function setLoading(on) {
  if (on) {
    loadingOverlay.removeAttribute('hidden');
  } else {
    loadingOverlay.setAttribute('hidden', '');
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  // Cache for the pre-paint inline script on next load
  try { sessionStorage.setItem('dashboard-theme', theme); } catch (_) {}
  // Redraw chart with new theme colours
  if (timeseriesData.length > 0) {
    renderChart(chartContainer, timeseriesData, currentTheme);
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await putSettings({ theme: next });
  } catch (err) {
    console.warn('Could not persist theme:', err);
  }
}

themeToggle.addEventListener('click', toggleTheme);

// ── Render helpers ────────────────────────────────────────────────────────
function renderSummary(data) {
  statVisitors.textContent = formatNumber(data.totalVisitors);
  statVisitorsSub.textContent = '30-day total';

  statRevenue.textContent = formatCurrency(data.totalRevenue);
  statRevenueSub.textContent = '30-day total';

  if (data.bestDay) {
    statBestday.textContent = formatNumber(data.bestDay.visitors);
    statBestdaySub.textContent = formatDate(data.bestDay.date);
  } else {
    statBestday.textContent = '—';
  }

  const trend = data.trend7d;
  const sign  = trend >= 0 ? '+' : '';
  statTrend.textContent = `${sign}${formatPercent(trend)}`;
  statTrendSub.textContent = 'vs prior 7 days';

  // Apply colour class to trend card value
  statTrend.className = 'stat-card__value';
  if (trend > 0) {
    statTrend.classList.add('stat-card__value--positive');
    statTrend.style.color = 'var(--color-positive)';
  } else if (trend < 0) {
    statTrend.classList.add('stat-card__value--negative');
    statTrend.style.color = 'var(--color-negative)';
  } else {
    statTrend.style.color = '';
  }
}

function renderCategories(data) {
  if (!data || data.length === 0) {
    categoriesList.innerHTML = '<p style="color:var(--color-text-muted);font-size:0.85rem;">No data.</p>';
    return;
  }

  const maxVal = Math.max(...data.map((d) => Number(d.value)));

  categoriesList.innerHTML = data.map((cat) => {
    const pct = maxVal > 0 ? (Number(cat.value) / maxVal) * 100 : 0;
    const safeVal = formatNumber(Number(cat.value));
    // Escape HTML
    const safeName = cat.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `
      <div class="category-row">
        <div class="category-row__header">
          <span class="category-row__name" title="${safeName}">${safeName}</span>
          <span class="category-row__value">${safeVal}</span>
        </div>
        <div class="category-row__bar-track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${safeName}: ${safeVal}">
          <div class="category-row__bar-fill" style="width:${pct.toFixed(2)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderRecentTable(data) {
  if (!data || data.length === 0) {
    recentTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--color-text-muted);padding:2rem;">No recent items.</td></tr>';
    return;
  }

  recentTbody.innerHTML = data.map((item) => {
    const safeName = item.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const safeCat  = item.category.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `
      <tr>
        <td title="${safeName}">${safeName}</td>
        <td title="${safeCat}">${safeCat}</td>
        <td class="col-value">${formatCurrency(item.value)}</td>
        <td class="col-date">${formatDate(item.created_at)}</td>
      </tr>
    `;
  }).join('');
}

// ── Chart resize handling ─────────────────────────────────────────────────
function setupChartResize() {
  if (chartResizeObserver) {
    chartResizeObserver.disconnect();
  }
  chartResizeObserver = new ResizeObserver(() => {
    if (timeseriesData.length > 0) {
      renderChart(chartContainer, timeseriesData, currentTheme);
    }
  });
  chartResizeObserver.observe(chartContainer);
}

// ── Main load ─────────────────────────────────────────────────────────────
async function loadDashboard() {
  setLoading(true);
  hideError();

  try {
    // Load settings first so theme is applied before data renders
    let settings;
    try {
      settings = await fetchSettings();
      applyTheme(settings.theme);
    } catch (err) {
      console.warn('Could not load settings:', err);
    }

    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent(),
    ]);

    // Render each section
    renderSummary(summary);

    timeseriesData = timeseries;
    renderChart(chartContainer, timeseriesData, currentTheme);
    setupChartResize();

    renderCategories(categories);
    renderRecentTable(recent);

    setLoading(false);
  } catch (err) {
    setLoading(false);
    console.error('Dashboard load error:', err);
    showError(
      'Unable to reach the server. Please ensure the backend is running on port 3001.',
    );
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
loadDashboard();
