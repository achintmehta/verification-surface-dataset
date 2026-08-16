import { api } from './api.js';
import { initChart, draw as drawChart } from './chart.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $body          = document.body;
const $loading       = document.getElementById('loading-state');
const $error         = document.getElementById('error-state');
const $errorMsg      = document.getElementById('error-message');
const $dashboard     = document.getElementById('dashboard');
const $themeToggle   = document.getElementById('theme-toggle');
const $retryBtn      = document.getElementById('retry-btn');

// Stat card values
const $statVisitors  = document.getElementById('stat-visitors');
const $statRevenue   = document.getElementById('stat-revenue');
const $statBestVis   = document.getElementById('stat-best-visitors');
const $statBestDate  = document.getElementById('stat-best-date');
const $statAvg       = document.getElementById('stat-avg');
const $trendIcon     = document.getElementById('trend-icon');
const $trendText     = document.getElementById('trend-text');

// Chart
const $canvas        = document.getElementById('timeseries-canvas');

// Breakdown
const $breakdownList = document.getElementById('breakdown-list');

// Table
const $recentTbody   = document.getElementById('recent-tbody');

// ── State ─────────────────────────────────────────────────────────────────────
let currentTheme = 'light';

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  currentTheme = theme;
  $body.classList.remove('theme-light', 'theme-dark');
  $body.classList.add(`theme-${theme}`);
}

async function loadTheme() {
  try {
    const { theme } = await api.getSettings();
    applyTheme(theme);
  } catch {
    // Default to light if settings unavailable
    applyTheme('light');
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Redraw chart with new theme colours
  try {
    await api.putSettings({ theme: next });
  } catch (err) {
    console.warn('Could not persist theme:', err);
  }
  // Redraw chart to pick up new CSS vars
  const canvas = document.getElementById('timeseries-canvas');
  if (canvas && canvas._chartData) {
    drawChart(canvas._chartData);
  }
}

$themeToggle.addEventListener('click', toggleTheme);

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDatetime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Render functions ──────────────────────────────────────────────────────────

function renderSummary(summary, timeseries) {
  $statVisitors.textContent = fmtNumber(summary.total_visitors);
  $statRevenue.textContent  = fmtCurrency(summary.total_revenue);
  $statBestVis.textContent  = fmtNumber(summary.best_day.visitors);
  $statBestDate.textContent = fmtDate(summary.best_day.date);

  // Avg daily visitors from timeseries
  if (timeseries && timeseries.length > 0) {
    const avg = summary.total_visitors / timeseries.length;
    $statAvg.textContent = fmtNumber(avg);
  }

  // Trend
  const pct = summary.trend_7d_pct;
  if (pct > 0) {
    $trendIcon.textContent = '▲';
    $trendIcon.className = 'trend-indicator trend-up';
    $trendText.textContent = `+${pct}% vs prev 7 days`;
    $trendText.style.color = 'var(--trend-up)';
  } else if (pct < 0) {
    $trendIcon.textContent = '▼';
    $trendIcon.className = 'trend-indicator trend-down';
    $trendText.textContent = `${pct}% vs prev 7 days`;
    $trendText.style.color = 'var(--trend-down)';
  } else {
    $trendIcon.textContent = '—';
    $trendIcon.className = 'trend-indicator trend-neutral';
    $trendText.textContent = 'No change vs prev 7 days';
    $trendText.style.color = 'var(--trend-neutral)';
  }
}

function renderChart(timeseries) {
  initChart($canvas);
  $canvas._chartData = timeseries;
  // Use rAF to ensure the container has been laid out
  requestAnimationFrame(() => {
    drawChart(timeseries);
  });
}

function renderCategories(categories) {
  if (!categories.length) {
    $breakdownList.innerHTML = '<p style="color:var(--text-secondary)">No data</p>';
    return;
  }

  const maxVal = categories[0].value; // already sorted desc

  $breakdownList.innerHTML = '';
  categories.forEach((cat) => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;

    const item = document.createElement('div');
    item.className = 'breakdown-item';

    const header = document.createElement('div');
    header.className = 'breakdown-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'breakdown-name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name; // tooltip for truncated names

    const valEl = document.createElement('span');
    valEl.className = 'breakdown-value';
    valEl.textContent = fmtCurrency(cat.value);

    header.appendChild(nameEl);
    header.appendChild(valEl);

    const track = document.createElement('div');
    track.className = 'breakdown-track';

    const bar = document.createElement('div');
    bar.className = 'breakdown-bar';
    bar.style.width = pct.toFixed(1) + '%';
    bar.setAttribute('aria-label', `${cat.name}: ${pct.toFixed(0)}%`);

    track.appendChild(bar);
    item.appendChild(header);
    item.appendChild(track);
    $breakdownList.appendChild(item);
  });
}

function renderTable(items) {
  if (!items.length) {
    $recentTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary)">No recent items</td></tr>';
    return;
  }

  $recentTbody.innerHTML = '';
  items.forEach((item) => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;

    const tdCat = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = item.category;
    badge.title = item.category;
    tdCat.appendChild(badge);

    const tdVal = document.createElement('td');
    tdVal.className = 'col-value';
    tdVal.textContent = fmtCurrency(item.value);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = fmtDatetime(item.created_at);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    $recentTbody.appendChild(tr);
  });
}

// ── UI state helpers ──────────────────────────────────────────────────────────

function showLoading() {
  $loading.removeAttribute('hidden');
  $error.setAttribute('hidden', '');
  $dashboard.setAttribute('hidden', '');
}

function showError(msg) {
  $loading.setAttribute('hidden', '');
  $error.removeAttribute('hidden');
  $dashboard.setAttribute('hidden', '');
  if (msg) $errorMsg.textContent = msg;
}

function showDashboard() {
  $loading.setAttribute('hidden', '');
  $error.setAttribute('hidden', '');
  $dashboard.removeAttribute('hidden');
}

// ── Main load ─────────────────────────────────────────────────────────────────

async function loadDashboard() {
  showLoading();

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      api.getSummary(),
      api.getTimeseries(),
      api.getCategories(),
      api.getRecent(),
    ]);

    renderSummary(summary, timeseries);
    renderCategories(categories);
    renderTable(recent);

    showDashboard();

    // Chart needs the panel to be visible first
    renderChart(timeseries);

  } catch (err) {
    console.error('Dashboard load error:', err);
    showError(
      'Could not connect to the backend server. Please ensure the server is running and try again.'
    );
  }
}

$retryBtn.addEventListener('click', loadDashboard);

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
  // Apply persisted theme before first paint
  await loadTheme();
  await loadDashboard();
})();
