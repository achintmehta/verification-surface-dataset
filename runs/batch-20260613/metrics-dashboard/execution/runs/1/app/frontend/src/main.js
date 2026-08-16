/**
 * Metrics Dashboard — main entry point
 *
 * Responsibilities:
 *  1. Load persisted theme from API and apply it before first paint
 *  2. Fetch all dashboard data from the API
 *  3. Render stat cards, time-series chart, category bars, recent-items table
 *  4. Handle theme toggle (persist via API)
 *  5. Redraw chart on container resize
 *  6. Show error state when backend is unreachable
 */

import { drawChart } from './chart.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_BASE = '/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n, opts = {}) {
  return new Intl.NumberFormat('en-US', opts).format(n);
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(dateStr) {
  // dateStr may be ISO date "YYYY-MM-DD" or full ISO timestamp
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtShortDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Theme management
// ---------------------------------------------------------------------------
let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Cache in sessionStorage for instant apply on next load (before API responds)
  sessionStorage.setItem('__theme', theme);
}

async function loadTheme() {
  try {
    const settings = await apiFetch('/settings');
    applyTheme(settings.theme || 'light');
  } catch {
    // Fall back to sessionStorage value already applied by inline script
    const stored = sessionStorage.getItem('__theme');
    if (stored) applyTheme(stored);
  }
}

async function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Redraw chart with new theme colours
  if (window.__chartData) {
    scheduleChartDraw(window.__chartData);
  }
  try {
    await apiFetch('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    console.warn('Could not persist theme:', err);
  }
}

// ---------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------
function renderStatCards(summary) {
  // Visitors
  document.getElementById('stat-visitors').textContent = fmt(summary.total_visitors);
  document.getElementById('stat-visitors-sub').textContent = '30-day total';

  // Revenue
  document.getElementById('stat-revenue').textContent = fmtCurrency(summary.total_revenue);
  document.getElementById('stat-revenue-sub').textContent = '30-day total';

  // Best day
  const bestEl = document.getElementById('stat-best-day');
  bestEl.textContent = fmt(summary.best_day.visitors);
  document.getElementById('stat-best-day-sub').textContent =
    `on ${fmtDate(summary.best_day.date)}`;

  // 7-day trend
  const trendEl = document.getElementById('stat-trend');
  const trendSub = document.getElementById('stat-trend-sub');
  const pct = summary.trend_pct;
  const sign = pct > 0 ? '+' : '';
  trendEl.textContent = `${sign}${pct}%`;
  trendSub.textContent = 'vs previous 7 days';

  // Colour the trend
  trendEl.className = 'stat-card__value';
  if (pct > 0)       trendEl.classList.add('trend--up');
  else if (pct < 0)  trendEl.classList.add('trend--down');
  else               trendEl.classList.add('trend--flat');
}

// ---------------------------------------------------------------------------
// Time-series chart
// ---------------------------------------------------------------------------
let chartResizeObserver = null;
let chartDrawTimeout = null;

function scheduleChartDraw(data) {
  window.__chartData = data;
  if (chartDrawTimeout) clearTimeout(chartDrawTimeout);
  chartDrawTimeout = setTimeout(() => {
    const container = document.getElementById('chart-container');
    if (!container) return;
    drawChart(container, data);
  }, 16);
}

function initChartResize(data) {
  const container = document.getElementById('chart-container');
  if (!container) return;

  // Initial draw
  scheduleChartDraw(data);

  // Observe container size changes
  if (chartResizeObserver) chartResizeObserver.disconnect();
  chartResizeObserver = new ResizeObserver(() => {
    scheduleChartDraw(data);
  });
  chartResizeObserver.observe(container);
}

// ---------------------------------------------------------------------------
// Category bars
// ---------------------------------------------------------------------------
function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  if (!container) return;

  const maxVal = Math.max(...categories.map(c => Number(c.value)));

  container.innerHTML = '';
  for (const cat of categories) {
    const val = Number(cat.value);
    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'category-row';
    row.setAttribute('role', 'listitem');

    row.innerHTML = `
      <div class="category-row__header">
        <span class="category-row__name" title="${escHtml(cat.name)}">${escHtml(cat.name)}</span>
        <span class="category-row__value">${fmt(val)}</span>
      </div>
      <div class="category-row__track" role="progressbar"
           aria-valuenow="${val}" aria-valuemin="0" aria-valuemax="${maxVal}"
           aria-label="${escHtml(cat.name)}: ${fmt(val)}">
        <div class="category-row__bar" style="width: ${pct.toFixed(2)}%"></div>
      </div>
    `;
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Recent items table
// ---------------------------------------------------------------------------
function renderRecentItems(items) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  for (const item of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(item.name)}</td>
      <td class="col-category" title="${escHtml(item.category)}">${escHtml(item.category)}</td>
      <td class="col-value">${fmtCurrency(item.value)}</td>
      <td class="col-date">${fmtShortDate(item.created_at)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Error / loading state helpers
// ---------------------------------------------------------------------------
function showError() {
  document.getElementById('loading-state').hidden = true;
  document.getElementById('dashboard').hidden = true;
  document.getElementById('error-banner').hidden = false;
}

function showDashboard() {
  document.getElementById('loading-state').hidden = true;
  document.getElementById('error-banner').hidden = true;
  document.getElementById('dashboard').hidden = false;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function init() {
  // Apply theme as early as possible (inline script already did sessionStorage,
  // but we want the API-persisted value)
  await loadTheme();

  // Wire up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Fetch all data in parallel
  let summary, timeseries, categories, recent;
  try {
    [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/summary'),
      apiFetch('/timeseries'),
      apiFetch('/categories'),
      apiFetch('/recent'),
    ]);
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    showError();
    return;
  }

  // Render everything
  renderStatCards(summary);
  renderCategories(categories);
  renderRecentItems(recent);

  // Show dashboard before chart draw so container has dimensions
  showDashboard();

  // Draw chart (needs container to be visible for size measurement)
  initChartResize(timeseries);
}

init();
