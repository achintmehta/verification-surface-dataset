import { renderStatCards } from './components/statCards.js';
import { renderCategories } from './components/categories.js';
import { renderRecentTable } from './components/recentTable.js';
import { TimeSeriesChart } from './components/chart.js';
import { initThemeToggle } from './components/themeToggle.js';
import { fetchAll } from './api.js';

let chart = null;

async function init() {
  // 1. Apply persisted theme before rendering data (reduces flash)
  await initThemeToggle();

  // 2. Fetch all dashboard data in parallel
  const { summary, timeseries, categories, recent, error } = await fetchAll();

  if (error) {
    showError(error);
    clearSkeletons();
    return;
  }

  // 3. Render stat cards
  renderStatCards(summary);

  // 4. Render time-series chart
  const canvas = document.getElementById('timeseries-chart');
  const chartContainer = document.getElementById('chart-container');

  if (canvas && chartContainer) {
    chart = new TimeSeriesChart(canvas, timeseries);

    // Initial draw (after a microtask so the container has its final size)
    requestAnimationFrame(() => {
      chart.draw();
    });

    // Redraw whenever the container resizes
    const ro = new ResizeObserver(() => {
      if (chart) chart.draw();
    });
    ro.observe(chartContainer);
  }

  // 5. Render category bars
  renderCategories(categories);

  // 6. Render recent items table
  renderRecentTable(recent);
}

function showError(message) {
  const banner = document.getElementById('error-banner');
  const msgEl  = document.getElementById('error-message');
  if (banner && msgEl) {
    msgEl.textContent = message;
    banner.hidden = false;
  }
}

function clearSkeletons() {
  // Replace skeleton stat cards with offline state
  const statCards = document.getElementById('stat-cards');
  if (statCards) {
    statCards.innerHTML = `
      <div class="stat-card" style="grid-column: 1 / -1; text-align: center;
           color: var(--color-text-muted); padding: 2rem 1rem;">
        Dashboard data unavailable — backend is offline.
      </div>
    `;
  }

  // Clear chart canvas
  const canvas = document.getElementById('timeseries-chart');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const container = canvas.parentElement;
      const w = container ? container.clientWidth  : 300;
      const h = container ? container.clientHeight : 200;
      canvas.width  = w;
      canvas.height = h;
      canvas.style.width  = w + 'px';
      canvas.style.height = h + 'px';
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-text-muted').trim();
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data — backend offline', w / 2, h / 2);
    }
  }

  // Clear categories
  const catList = document.getElementById('categories-list');
  if (catList) {
    catList.innerHTML = `
      <p style="color: var(--color-text-muted); font-size: 0.875rem; padding: 0.5rem 0;">
        No data available.
      </p>
    `;
  }

  // Clear table
  const tbody = document.getElementById('recent-tbody');
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center; color: var(--color-text-muted);
            padding: 2rem;">
          No data available.
        </td>
      </tr>
    `;
  }
}

init();
