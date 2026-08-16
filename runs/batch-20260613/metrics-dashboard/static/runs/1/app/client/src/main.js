/**
 * Dashboard entry point.
 *
 * Boot sequence:
 *  1. Fetch persisted theme and apply it before rendering (no flash).
 *  2. Fetch all API data in parallel.
 *  3. Render cards, chart, categories, table.
 *  4. Wire up theme toggle.
 *  5. On error, show explicit error state.
 */

import { api } from './api.js';
import { applyTheme, initThemeToggle, onThemeChange } from './theme.js';
import { renderCards } from './cards.js';
import { initChart } from './chart.js';
import { renderCategories } from './categories.js';
import { renderTable } from './table.js';

// ── Elements ──────────────────────────────────────────────────────────────
const loadingEl  = document.getElementById('loading-state');
const errorEl    = document.getElementById('error-state');
const errorMsgEl = document.getElementById('error-message');
const dashboardEl = document.getElementById('dashboard');
const retryBtn   = document.getElementById('retry-btn');

// ── State ─────────────────────────────────────────────────────────────────
let chartInstance = null;

// ── Helpers ───────────────────────────────────────────────────────────────
function showLoading() {
  loadingEl.hidden  = false;
  errorEl.hidden    = true;
  dashboardEl.hidden = true;
}

function showError(message) {
  loadingEl.hidden  = true;
  errorEl.hidden    = false;
  dashboardEl.hidden = true;
  if (errorMsgEl) errorMsgEl.textContent = message;
}

function showDashboard() {
  loadingEl.hidden  = true;
  errorEl.hidden    = true;
  dashboardEl.hidden = false;
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  showLoading();

  // Step 1: Apply persisted theme before rendering to avoid flash.
  // If the settings API fails we fall back to 'light' — the dashboard
  // will still load; theme just won't be persisted.
  try {
    const settings = await api.getSettings();
    applyTheme(settings.theme ?? 'light');
  } catch {
    applyTheme('light');
  }

  // Step 2: Fetch all dashboard data in parallel.
  let summary, timeseries, categories, recent;
  try {
    [summary, timeseries, categories, recent] = await Promise.all([
      api.getSummary(),
      api.getTimeseries(),
      api.getCategories(),
      api.getRecent(),
    ]);
  } catch (err) {
    showError(
      'The backend server is not reachable. Please start the server and reload the page.'
    );
    console.error('[dashboard] Failed to load data:', err);
    return;
  }

  // Step 3: Render all sections.
  renderCards(summary);

  // Chart
  const chartContainer = document.getElementById('chart-container');
  if (chartContainer) {
    if (chartInstance) chartInstance.destroy();
    chartInstance = initChart(chartContainer, timeseries);
  }

  // Categories
  const categoriesEl = document.getElementById('categories-list');
  if (categoriesEl) renderCategories(categoriesEl, categories);

  // Table
  const tbody = document.getElementById('recent-tbody');
  if (tbody) renderTable(tbody, recent);

  // Step 4: Show dashboard.
  showDashboard();

  // Step 5: Wire up theme toggle (after dashboard is visible).
  initThemeToggle();

  // Redraw chart when theme changes (CSS vars change).
  onThemeChange(() => {
    if (chartInstance) chartInstance.redraw();
  });
}

// ── Retry button ──────────────────────────────────────────────────────────
if (retryBtn) {
  retryBtn.addEventListener('click', () => boot());
}

// ── Start ─────────────────────────────────────────────────────────────────
boot();
