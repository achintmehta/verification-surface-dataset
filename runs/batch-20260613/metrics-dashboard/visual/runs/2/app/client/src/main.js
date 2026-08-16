import { drawTimeseriesChart } from './chart.js';
import { formatNumber, formatCurrency, formatDate, formatPercent } from './format.js';

const API_BASE = 'http://localhost:3001';

// ============================================================
// State
// ============================================================
let currentTheme = 'light';
let timeseriesData = [];
let resizeTimer = null;

// ============================================================
// DOM refs
// ============================================================
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const dashboard = document.getElementById('dashboard');
const themeToggle = document.getElementById('themeToggle');
const themeLabel = document.getElementById('themeLabel');
const retryBtn = document.getElementById('retryBtn');

// ============================================================
// Theme
// ============================================================
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  themeLabel.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  // Redraw chart with new theme colors
  if (timeseriesData.length > 0) {
    redrawChart();
  }
}

async function loadTheme() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    if (!res.ok) throw new Error('Settings fetch failed');
    const data = await res.json();
    applyTheme(data.theme || 'light');
  } catch {
    // Default to light if settings unavailable
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    });
  } catch (err) {
    console.warn('Could not persist theme:', err);
  }
}

themeToggle.addEventListener('click', toggleTheme);

// ============================================================
// Chart resize handling
// ============================================================
function redrawChart() {
  const canvas = document.getElementById('timeseriesChart');
  const container = document.getElementById('timeseriesContainer');
  if (!canvas || !container || timeseriesData.length === 0) return;
  drawTimeseriesChart(canvas, container, timeseriesData, currentTheme);
}

function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawChart, 80);
}

window.addEventListener('resize', onResize);

// Also use ResizeObserver for more reliable container-level resize detection
let resizeObserver = null;
function setupResizeObserver() {
  const container = document.getElementById('timeseriesContainer');
  if (!container || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawChart, 80);
  });
  resizeObserver.observe(container);
}

// ============================================================
// Data fetching
// ============================================================
async function fetchAll() {
  const [summary, timeseries, categories, recent] = await Promise.all([
    fetch(`${API_BASE}/api/summary`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    fetch(`${API_BASE}/api/timeseries`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    fetch(`${API_BASE}/api/categories`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    fetch(`${API_BASE}/api/recent`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
  ]);
  return { summary, timeseries, categories, recent };
}

// ============================================================
// Render functions
// ============================================================
function renderSummary(summary) {
  // Total Visitors
  document.getElementById('statVisitors').textContent = formatNumber(summary.total_visitors);

  // Total Revenue
  document.getElementById('statRevenue').textContent = formatCurrency(summary.total_revenue);

  // Best Day
  document.getElementById('statBestDay').textContent = formatCurrency(summary.best_day_revenue);
  document.getElementById('statBestDayDate').textContent = formatDate(summary.best_day_date);

  // 7-Day Trend
  const trendEl = document.getElementById('statTrend');
  const pct = summary.trend_pct;
  trendEl.textContent = formatPercent(pct);
  trendEl.className = 'stat-card__value';
  if (pct > 0) {
    trendEl.classList.add('stat-card__value--positive');
    trendEl.setAttribute('data-trend', 'up');
  } else if (pct < 0) {
    trendEl.classList.add('stat-card__value--negative');
    trendEl.setAttribute('data-trend', 'down');
  }
}

function renderTimeseries(data) {
  timeseriesData = data;
  // Use requestAnimationFrame to ensure container is laid out
  requestAnimationFrame(() => {
    redrawChart();
  });
}

function renderCategories(data) {
  const container = document.getElementById('categoriesList');
  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:var(--color-text-muted);font-size:0.875rem;">No data available.</p>';
    return;
  }

  const maxVal = Math.max(...data.map(d => Number(d.value)));
  const barColors = [
    'var(--color-bar-1)',
    'var(--color-bar-2)',
    'var(--color-bar-3)',
    'var(--color-bar-4)',
    'var(--color-bar-5)',
    'var(--color-bar-6)',
  ];

  container.innerHTML = data.map((item, i) => {
    const pct = maxVal > 0 ? (Number(item.value) / maxVal) * 100 : 0;
    const color = barColors[i % barColors.length];
    return `
      <div class="category-item">
        <div class="category-item__header">
          <span class="category-item__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          <span class="category-item__value">${formatNumber(item.value)}</span>
        </div>
        <div class="category-item__bar-track">
          <div class="category-item__bar-fill" style="width:${pct.toFixed(2)}%;background:${color};"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderRecent(data) {
  const tbody = document.getElementById('recentTableBody');
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--color-text-muted);">No recent items.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
      <td class="col-category"><span class="category-badge" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
      <td class="col-value">${formatCurrency(item.value)}</td>
      <td class="col-date">${formatDate(item.created_at)}</td>
    </tr>
  `).join('');
}

// ============================================================
// Utility
// ============================================================
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Main init
// ============================================================
async function init() {
  // Show loading
  loadingState.classList.remove('hidden');
  errorState.classList.add('hidden');
  dashboard.classList.add('hidden');

  // Load theme first (before data, to avoid flash)
  await loadTheme();

  try {
    const { summary, timeseries, categories, recent } = await fetchAll();

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);

    // Show dashboard before drawing chart so container has dimensions
    loadingState.classList.add('hidden');
    dashboard.classList.remove('hidden');

    // Set up resize observer now that container is in DOM
    setupResizeObserver();

    // Draw chart after dashboard is visible
    renderTimeseries(timeseries);

  } catch (err) {
    console.error('Dashboard load error:', err);
    loadingState.classList.add('hidden');
    errorState.classList.remove('hidden');
    errorMessage.textContent = `Could not connect to the backend server (${err.message}). Please ensure the server is running on port 3001 and try again.`;
  }
}

retryBtn.addEventListener('click', init);

// Start
init();
