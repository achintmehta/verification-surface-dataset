/**
 * Metrics Dashboard — main entry point
 *
 * Responsibilities:
 *  1. Load persisted theme from API and apply it before first paint
 *  2. Fetch all API data in parallel
 *  3. Render stat cards, time-series SVG chart, category bars, recent table
 *  4. Handle theme toggle (persist via API)
 *  5. Redraw chart on resize
 */

import { drawTimeseriesChart } from './chart.js';

const API_BASE = '/api';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n, opts = {}) {
  return new Intl.NumberFormat('en-US', opts).format(n);
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
  // Extract date portion to avoid timezone shifts
  const datePart = String(dateStr).slice(0, 10);
  const [year, month, day] = datePart.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtShortDate(dateStr) {
  // Extract date portion to avoid timezone shifts
  const datePart = String(dateStr).slice(0, 10);
  const [year, month, day] = datePart.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json();
}

// ── Error handling ────────────────────────────────────────────────────────────

function showError(msg) {
  const banner = document.getElementById('error-banner');
  const msgEl  = document.getElementById('error-message');
  msgEl.textContent = msg || 'Unable to reach the backend. Please ensure the server is running.';
  banner.hidden = false;
}

function hideError() {
  document.getElementById('error-banner').hidden = true;
}

// ── Theme ─────────────────────────────────────────────────────────────────────

let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Cache in sessionStorage for instant apply on next load (before API responds)
  try { sessionStorage.setItem('__theme__', theme); } catch (e) {}
}

async function loadTheme() {
  try {
    const { theme } = await apiFetch('/settings');
    applyTheme(theme);
  } catch (e) {
    // Fall back to sessionStorage or light
    const stored = (() => { try { return sessionStorage.getItem('__theme__'); } catch { return null; } })();
    applyTheme(stored === 'dark' ? 'dark' : 'light');
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Redraw chart with new theme colors
  if (window.__timeseriesData) {
    drawTimeseriesChart(
      document.getElementById('timeseries-svg'),
      document.getElementById('timeseries-container'),
      window.__timeseriesData
    );
  }
  // Persist
  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (e) {
    console.warn('Could not persist theme:', e);
  }
}

// ── Stat Cards ────────────────────────────────────────────────────────────────

function renderSummary(data) {
  // Remove skeleton
  document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('skeleton'));

  // Total visitors
  document.getElementById('val-visitors').textContent = fmt(data.totalVisitors);
  document.getElementById('trend-visitors').textContent = 'All time';

  // Total revenue
  document.getElementById('val-revenue').textContent = fmtCurrency(data.totalRevenue);
  document.getElementById('trend-revenue').textContent = 'All time';

  // Best day
  const bestEl = document.getElementById('val-bestday');
  bestEl.textContent = fmt(data.bestDay.visitors);
  document.getElementById('trend-bestday').textContent = fmtDate(data.bestDay.date);

  // 7-day trend
  const trendEl  = document.getElementById('val-trend');
  const detailEl = document.getElementById('trend-detail');
  const pct = data.trendPct;
  const sign = pct > 0 ? '+' : '';
  trendEl.textContent = `${sign}${pct}%`;
  trendEl.className = 'stat-value ' + (pct > 0 ? 'trend-up' : pct < 0 ? 'trend-down' : '');
  detailEl.textContent = 'vs previous 7 days';
  detailEl.className = 'stat-trend ' + (pct > 0 ? 'trend-up' : pct < 0 ? 'trend-down' : '');
}

// ── Category Bars ─────────────────────────────────────────────────────────────

function renderCategories(data) {
  const container = document.getElementById('categories-bars');
  container.innerHTML = '';

  const maxVal = Math.max(...data.map(d => d.value));

  data.forEach(cat => {
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'category-row';

    const nameRow = document.createElement('div');
    nameRow.className = 'category-name-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'category-name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name; // tooltip for truncated names

    const valEl = document.createElement('span');
    valEl.className = 'category-value';
    valEl.textContent = fmt(cat.value);

    nameRow.appendChild(nameEl);
    nameRow.appendChild(valEl);

    const track = document.createElement('div');
    track.className = 'category-track';

    const fill = document.createElement('div');
    fill.className = 'category-fill';
    fill.style.width = `${pct.toFixed(1)}%`;

    track.appendChild(fill);
    row.appendChild(nameRow);
    row.appendChild(track);
    container.appendChild(row);
  });
}

// ── Recent Items Table ────────────────────────────────────────────────────────

function renderRecent(data) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';

  if (!data || data.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted)">No recent items</td>';
    tbody.appendChild(tr);
    return;
  }

  data.forEach(item => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    tdName.title = item.name;

    const tdCat = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = item.category;
    badge.title = item.category;
    tdCat.appendChild(badge);

    const tdVal = document.createElement('td');
    tdVal.className = 'col-right';
    tdVal.textContent = fmtCurrency(item.value);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-right';
    tdDate.textContent = fmtShortDate(item.created_at);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    tbody.appendChild(tr);
  });
}

// ── Chart resize handling ─────────────────────────────────────────────────────

let resizeTimer;
function scheduleChartRedraw() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (window.__timeseriesData) {
      drawTimeseriesChart(
        document.getElementById('timeseries-svg'),
        document.getElementById('timeseries-container'),
        window.__timeseriesData
      );
    }
  }, 80);
}

function onResize() {
  scheduleChartRedraw();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  // Apply theme immediately (may already be set by inline script)
  await loadTheme();

  // Wire up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Fetch all data in parallel
  let summary, timeseries, categories, recent;
  let hasError = false;

  try {
    [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/summary'),
      apiFetch('/timeseries'),
      apiFetch('/categories'),
      apiFetch('/recent'),
    ]);
    hideError();
  } catch (err) {
    hasError = true;
    showError(
      'Unable to reach the backend server. Please start the backend and reload the page.'
    );
    console.error('API fetch failed:', err);
    // Show empty states
    document.querySelectorAll('.stat-card').forEach(c => {
      c.classList.remove('skeleton');
    });
    document.getElementById('recent-tbody').innerHTML =
      '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted)">No data — backend unavailable</td></tr>';
    return;
  }

  // Render everything
  renderSummary(summary);
  renderCategories(categories);
  renderRecent(recent);

  // Store timeseries globally for resize redraws
  window.__timeseriesData = timeseries;

  // Draw chart
  drawTimeseriesChart(
    document.getElementById('timeseries-svg'),
    document.getElementById('timeseries-container'),
    timeseries
  );

  // Listen for resize — use ResizeObserver on the chart container for accuracy
  window.addEventListener('resize', onResize);

  // Also observe the chart container directly (handles sidebar collapse, etc.)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => scheduleChartRedraw());
    const chartContainer = document.getElementById('timeseries-container');
    if (chartContainer) ro.observe(chartContainer);
  }
}

init();
