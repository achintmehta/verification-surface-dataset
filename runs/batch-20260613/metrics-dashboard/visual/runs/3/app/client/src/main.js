import { renderChart } from './chart.js';

const API = '/api';

// ============================================================
// Utilities
// ============================================================
function fmt(n, opts = {}) {
  return new Intl.NumberFormat('en-US', opts).format(n);
}

function fmtCurrency(n) {
  if (n >= 1_000_000) {
    return '$' + (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  }
  return '$' + fmt(Math.round(n));
}

function fmtDate(str) {
  // Use UTC to avoid timezone shifts on date-only strings
  const d = new Date(str);
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function fmtShortDate(str) {
  const d = new Date(str);
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ============================================================
// Theme
// ============================================================
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('theme-dark',  theme === 'dark');
  // Re-render chart with new theme colors (after a microtask so CSS vars update)
  requestAnimationFrame(() => {
    if (window._timeseriesData) {
      renderChart(document.getElementById('timeseries-svg'), window._timeseriesData);
    }
  });
}

async function loadTheme() {
  try {
    const res = await fetch(`${API}/settings`);
    if (!res.ok) throw new Error('settings fetch failed');
    const { theme } = await res.json();
    applyTheme(theme);
  } catch {
    applyTheme('light');
  }
}

async function saveTheme(theme) {
  try {
    await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
  } catch (err) {
    console.warn('Could not save theme:', err);
  }
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  saveTheme(next);
});

// ============================================================
// Error handling
// ============================================================
function showError(msg) {
  const banner = document.getElementById('error-banner');
  const msgEl  = document.getElementById('error-message');
  msgEl.textContent = msg || 'Unable to reach the backend. Please ensure the server is running.';
  banner.hidden = false;
}

function hideError() {
  document.getElementById('error-banner').hidden = true;
}

// ============================================================
// Stat Cards
// ============================================================
function renderSummary(data) {
  document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('skeleton'));

  document.getElementById('stat-visitors').textContent = fmt(data.totalVisitors);
  document.getElementById('stat-revenue').textContent  = fmtCurrency(data.totalRevenue);
  document.getElementById('stat-best-revenue').textContent = fmtCurrency(data.bestDayRevenue);
  document.getElementById('stat-best-date').textContent    = fmtDate(data.bestDayDate);

  const pct     = data.trendPct;
  const sign    = pct >= 0 ? '+' : '';
  const arrow   = pct >= 0 ? '▲' : '▼';
  const cls     = pct >= 0 ? 'positive' : 'negative';

  const trendValEl = document.getElementById('stat-trend-pct');
  trendValEl.textContent = `${sign}${pct}%`;
  trendValEl.className   = `stat-value ${cls}`;

  const trendSub = document.getElementById('stat-trend');
  trendSub.textContent = `${arrow} vs prior 7 days`;
  trendSub.className   = `stat-sub ${cls}`;
}

// ============================================================
// Time-series chart
// ============================================================
function renderTimeseries(data) {
  window._timeseriesData = data;
  renderChart(document.getElementById('timeseries-svg'), data);
}

// ============================================================
// Category bars
// ============================================================
function renderCategories(data) {
  const container = document.getElementById('categories-container');
  container.innerHTML = '';

  if (!data || data.length === 0) {
    container.textContent = 'No data.';
    return;
  }

  const maxVal = Math.max(...data.map(d => d.value));

  for (const cat of data) {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'cat-row';

    const labelRow = document.createElement('div');
    labelRow.className = 'cat-label-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'cat-name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name;

    const valueEl = document.createElement('span');
    valueEl.className = 'cat-value';
    valueEl.textContent = fmtCurrency(cat.value);

    labelRow.appendChild(nameEl);
    labelRow.appendChild(valueEl);

    const track = document.createElement('div');
    track.className = 'cat-bar-track';

    const fill = document.createElement('div');
    fill.className = 'cat-bar-fill';
    // Animate: start at 0, then set real width
    fill.style.width = '0%';
    requestAnimationFrame(() => {
      fill.style.width = `${pct.toFixed(2)}%`;
    });

    track.appendChild(fill);
    row.appendChild(labelRow);
    row.appendChild(track);
    container.appendChild(row);
  }
}

// ============================================================
// Recent items table
// ============================================================
function renderRecent(data) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  if (!data || data.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" class="loading-cell">No recent items.</td>';
    tbody.appendChild(tr);
    return;
  }

  // Update count badge
  const badge = document.getElementById('recent-count');
  if (badge) badge.textContent = `${data.length} items`;

  for (const item of data) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'td-name';
    tdName.textContent = item.name;
    tdName.title = item.name;

    const tdCat = document.createElement('td');
    tdCat.className = 'td-category';
    tdCat.textContent = item.category;
    tdCat.title = item.category;

    const tdVal = document.createElement('td');
    tdVal.className = 'num-col td-value';
    tdVal.textContent = fmtCurrency(item.value);

    const tdDate = document.createElement('td');
    tdDate.className = 'num-col td-date';
    tdDate.textContent = fmtShortDate(item.createdAt);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    tbody.appendChild(tr);
  }
}

// ============================================================
// Data fetching
// ============================================================
async function fetchAll() {
  let results;
  try {
    results = await Promise.all([
      fetch(`${API}/summary`),
      fetch(`${API}/timeseries`),
      fetch(`${API}/categories`),
      fetch(`${API}/recent`),
    ]);
  } catch (err) {
    showError('Unable to reach the backend. Please ensure the server is running.');
    // Show empty states
    document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('skeleton'));
    document.getElementById('stat-visitors').textContent    = '—';
    document.getElementById('stat-revenue').textContent     = '—';
    document.getElementById('stat-best-revenue').textContent = '—';
    document.getElementById('stat-best-date').textContent   = '—';
    document.getElementById('stat-trend-pct').textContent   = '—';
    document.getElementById('stat-trend').textContent       = '—';
    document.getElementById('recent-tbody').innerHTML =
      '<tr><td colspan="4" class="loading-cell">Backend unavailable.</td></tr>';
    return;
  }

  const failed = results.find(r => !r.ok);
  if (failed) {
    showError(`API error: ${failed.status} ${failed.statusText}`);
    return;
  }

  hideError();

  const [summary, timeseries, categories, recent] = await Promise.all(
    results.map(r => r.json())
  );

  renderSummary(summary);
  renderTimeseries(timeseries);
  renderCategories(categories);
  renderRecent(recent);
}

// ============================================================
// Resize handling — debounced chart redraw
// Uses ResizeObserver on the chart container for accuracy,
// falls back to window resize event.
// ============================================================
let resizeTimer;

function scheduleChartRedraw() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (window._timeseriesData) {
      renderChart(document.getElementById('timeseries-svg'), window._timeseriesData);
    }
  }, 80);
}

// ResizeObserver watches the chart container directly
const chartContainer = document.getElementById('timeseries-container');
if (typeof ResizeObserver !== 'undefined' && chartContainer) {
  const ro = new ResizeObserver(scheduleChartRedraw);
  ro.observe(chartContainer);
} else {
  window.addEventListener('resize', scheduleChartRedraw);
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  await loadTheme();   // apply persisted theme before data loads
  await fetchAll();
}

boot();
