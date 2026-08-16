import { api } from './api.js';
import { TimeseriesChart } from './chart.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $themeToggle    = document.getElementById('theme-toggle');
const $errorBanner    = document.getElementById('error-banner');

// Stat card values
const $statVisitors    = document.getElementById('stat-visitors');
const $statVisitorsSub = document.getElementById('stat-visitors-sub');
const $statRevenue     = document.getElementById('stat-revenue');
const $statRevenueSub  = document.getElementById('stat-revenue-sub');
const $statBestday     = document.getElementById('stat-bestday');
const $statBestdaySub  = document.getElementById('stat-bestday-sub');
const $statTrend       = document.getElementById('stat-trend');
const $statTrendSub    = document.getElementById('stat-trend-sub');

// Chart
const $chartCanvas    = document.getElementById('timeseries-chart');

// Categories
const $categoriesList = document.getElementById('categories-list');

// Table
const $recentTbody    = document.getElementById('recent-tbody');

// ── State ─────────────────────────────────────────────────────────────────────
let currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
let chart = null;

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

$themeToggle.addEventListener('click', async () => {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Redraw chart with new theme colours immediately
  if (chart) chart.redraw();
  // Persist to server
  try {
    await api.putSettings({ theme: next });
  } catch (err) {
    console.warn('Could not persist theme:', err);
  }
});

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtCurrency(n) {
  if (n >= 1_000_000) {
    return '$' + (n / 1_000_000).toFixed(2) + 'M';
  }
  if (n >= 1_000) {
    return '$' + (n / 1_000).toFixed(1) + 'k';
  }
  return '$' + n.toFixed(2);
}

function fmtShortDate(dateStr) {
  const d = parseDateSafe(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Parse a date string safely.
 * "YYYY-MM-DD" → treat as local midnight (avoids UTC-offset day-shift).
 * ISO timestamps → use native Date parsing.
 */
function parseDateSafe(dateStr) {
  if (!dateStr) return new Date(NaN);
  const s = String(dateStr);
  // Match bare date "YYYY-MM-DD"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(s);
}

// ── Render summary cards ──────────────────────────────────────────────────────
function renderSummary(data) {
  // Total visitors
  $statVisitors.textContent = fmtNumber(data.totalVisitors);
  $statVisitorsSub.textContent = '30-day total';

  // Total revenue
  $statRevenue.textContent = fmtCurrency(data.totalRevenue);
  $statRevenueSub.textContent = '30-day total';

  // Best day
  if (data.bestDay) {
    $statBestday.textContent = fmtNumber(data.bestDay.visitors);
    $statBestdaySub.textContent = fmtShortDate(data.bestDay.date);
  } else {
    $statBestday.textContent = '—';
    $statBestdaySub.textContent = '';
  }

  // 7-day trend
  const pct = data.sevenDayTrendPct;
  const sign = pct >= 0 ? '+' : '';
  const direction = pct >= 0 ? 'positive' : 'negative';
  const arrow = pct >= 0 ? '▲' : '▼';
  $statTrend.innerHTML = `
    <span class="stat-card__badge stat-card__badge--${direction}">
      ${arrow} ${sign}${pct.toFixed(1)}%
    </span>
  `;
  $statTrendSub.textContent = 'vs prior 7 days';
}

// ── Render chart ──────────────────────────────────────────────────────────────
function renderChart(data) {
  if (chart) {
    chart.update(data);
  } else {
    chart = new TimeseriesChart($chartCanvas, data);
  }
}

// ── Render categories ─────────────────────────────────────────────────────────
function renderCategories(data) {
  if (!data || data.length === 0) {
    $categoriesList.innerHTML = '<div class="loading-state">No data</div>';
    return;
  }

  const maxVal = data[0].value; // already sorted desc by server

  $categoriesList.innerHTML = data
    .map((cat) => {
      const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;

      // Format value
      let displayValue;
      if (cat.value >= 1_000_000) {
        displayValue = '$' + (cat.value / 1_000_000).toFixed(2) + 'M';
      } else if (cat.value >= 1_000) {
        displayValue = '$' + (cat.value / 1_000).toFixed(0) + 'k';
      } else {
        displayValue = '$' + cat.value.toLocaleString();
      }

      return `
        <div class="category-row">
          <span class="category-row__label" title="${escHtml(cat.name)}">${escHtml(cat.name)}</span>
          <div class="category-row__bar-track" role="presentation">
            <div class="category-row__bar-fill" style="width: ${pct.toFixed(1)}%"></div>
          </div>
          <span class="category-row__value">${displayValue}</span>
        </div>
      `;
    })
    .join('');
}

// ── Render recent items table ─────────────────────────────────────────────────
function renderRecent(data) {
  if (!data || data.length === 0) {
    $recentTbody.innerHTML =
      '<tr><td colspan="4" class="loading-state">No data</td></tr>';
    return;
  }

  $recentTbody.innerHTML = data
    .map((item) => {
      const value =
        '$' +
        Number(item.value).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      const date = fmtShortDate(item.createdAt);
      return `
        <tr>
          <td>${escHtml(item.name)}</td>
          <td>
            <span class="category-badge" title="${escHtml(item.category)}">
              ${escHtml(item.category)}
            </span>
          </td>
          <td class="col-value">${value}</td>
          <td class="col-date">${date}</td>
        </tr>
      `;
    })
    .join('');
}

// ── Error state ───────────────────────────────────────────────────────────────
function showError() {
  $errorBanner.hidden = false;
  // Show dash states in cards
  [$statVisitors, $statRevenue, $statBestday, $statTrend].forEach((el) => {
    el.textContent = '—';
  });
  $categoriesList.innerHTML =
    '<div class="loading-state">Server unavailable</div>';
  $recentTbody.innerHTML =
    '<tr><td colspan="4" class="loading-state">Server unavailable</td></tr>';
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent, settings] =
      await Promise.all([
        api.getSummary(),
        api.getTimeseries(),
        api.getCategories(),
        api.getRecent(),
        api.getSettings(),
      ]);

    // Apply persisted theme (may differ from the pre-paint inline script
    // if the inline script failed or ran before the module loaded)
    applyTheme(settings.theme);

    renderSummary(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderRecent(recent);

    $errorBanner.hidden = true;
  } catch (err) {
    console.error('Dashboard load failed:', err);
    showError();
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadDashboard();
