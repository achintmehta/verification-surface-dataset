/**
 * Main entry – loads theme first (before paint), then fetches all data and renders.
 */
import { loadTheme, initThemeToggle, getCurrentTheme, applyTheme } from './theme.js';
import { fetchSummary, fetchTimeseries, fetchCategories, fetchRecent } from './api.js';
import { renderCards } from './cards.js';
import { renderChart, redrawChart } from './chart.js';
import { renderCategories } from './categories.js';
import { renderTable } from './table.js';

async function init() {
  // 1. Load and apply persisted theme before rendering data
  await loadTheme();
  initThemeToggle();

  // 2. Redraw chart on theme toggle so colors update
  const origToggle = document.getElementById('theme-toggle');
  if (origToggle) {
    origToggle.addEventListener('click', () => {
      // Small delay to let CSS vars apply
      requestAnimationFrame(() => {
        redrawChart();
      });
    });
  }

  // 3. Fetch all data in parallel
  const errorEl = document.getElementById('error-state');
  const statCards = document.getElementById('stat-cards');
  const bodyGrid = document.getElementById('body-grid');
  const tableCard = document.getElementById('table-card');

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchSummary(),
      fetchTimeseries(),
      fetchCategories(),
      fetchRecent(),
    ]);

    // Render everything
    renderCards(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderTable(recent);

    // Make sure content is visible
    if (statCards) statCards.style.display = '';
    if (bodyGrid) bodyGrid.style.display = '';
    if (tableCard) tableCard.style.display = '';
    if (errorEl) errorEl.hidden = true;

  } catch (err) {
    console.error('Failed to load dashboard data:', err);

    // Show error state, hide data sections
    if (statCards) statCards.style.display = 'none';
    if (bodyGrid) bodyGrid.style.display = 'none';
    if (tableCard) tableCard.style.display = 'none';
    if (errorEl) errorEl.hidden = false;
  }
}

// Run
init();
