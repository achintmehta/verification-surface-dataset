/**
 * Dashboard entry point.
 *
 * Boot sequence:
 *  1. Apply persisted theme (before showing content to avoid flash).
 *  2. Fetch all API data in parallel.
 *  3. Render each section.
 *  4. Show dashboard / error state.
 */

import { getSummary, getTimeseries, getCategories, getRecent } from './api.js';
import { initTheme } from './theme.js';
import { renderStatCards }       from './components/statCards.js';
import { initTimeseriesChart }   from './components/timeseriesChart.js';
import { renderCategoryBars }    from './components/categoryBars.js';
import { renderRecentTable }     from './components/recentTable.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loadingEl  = document.getElementById('loading-state');
const dashboardEl = document.getElementById('dashboard');
const errorBanner = document.getElementById('error-banner');
const errorMsg    = document.getElementById('error-message');

function showLoading() {
  loadingEl?.removeAttribute('hidden');
  dashboardEl?.setAttribute('hidden', '');
  errorBanner?.setAttribute('hidden', '');
}

function showDashboard() {
  loadingEl?.setAttribute('hidden', '');
  dashboardEl?.removeAttribute('hidden');
  errorBanner?.setAttribute('hidden', '');
}

function showError(message) {
  loadingEl?.setAttribute('hidden', '');
  dashboardEl?.setAttribute('hidden', '');
  errorBanner?.removeAttribute('hidden');
  if (errorMsg) errorMsg.textContent = message;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  showLoading();

  // 1. Apply theme first (may fail gracefully if server is down)
  await initTheme();

  // 2. Fetch all data in parallel
  let summary, timeseries, categories, recent;
  try {
    [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);
  } catch (err) {
    console.error('[dashboard] failed to load data:', err);
    showError(
      'Unable to reach the server. Please ensure the backend is running on port 3001, then refresh.'
    );
    return;
  }

  // 3. Render sections
  try {
    renderStatCards(summary);
    renderCategoryBars(categories);
    renderRecentTable(recent);
  } catch (err) {
    console.error('[dashboard] render error:', err);
    showError('An error occurred while rendering the dashboard. Check the console for details.');
    return;
  }

  // 4. Show dashboard before initialising chart (chart needs visible container)
  showDashboard();

  // 5. Initialise chart (needs the container to be visible for sizing)
  try {
    initTimeseriesChart(timeseries);
  } catch (err) {
    console.error('[chart] init error:', err);
    // Non-fatal — dashboard is still usable without the chart
  }
}

bootstrap();
