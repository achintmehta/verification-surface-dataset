import { initTheme, setupThemeToggle } from './theme.js';
import { renderSummary } from './summary.js';
import { renderTimeseries } from './chart.js';
import { renderCategories } from './categories.js';
import { renderRecent } from './table.js';

const API = 'http://localhost:3001';

// ── Apply persisted theme before first paint ──────────────────────────────────
async function bootstrap() {
  // 1. Apply theme (fetches from server, falls back to localStorage)
  await initTheme(API);

  // 2. Wire up the toggle button
  setupThemeToggle(API);

  // 3. Load all dashboard data
  await loadDashboard();
}

async function loadDashboard() {
  const errorBanner = document.getElementById('error-banner');

  try {
    // Fetch all endpoints in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON(`${API}/api/summary`),
      fetchJSON(`${API}/api/timeseries`),
      fetchJSON(`${API}/api/categories`),
      fetchJSON(`${API}/api/recent`),
    ]);

    errorBanner.hidden = true;

    renderSummary(summary);
    renderTimeseries(timeseries);
    renderCategories(categories);
    renderRecent(recent);

  } catch (err) {
    console.error('[dashboard] Failed to load data:', err);
    errorBanner.hidden = false;

    // Show empty states
    renderSummaryError();
    renderTimeseriesError();
    renderCategoriesError();
    renderRecentError();
  }
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function renderSummaryError() {
  ['val-visitors', 'val-revenue', 'val-best-day', 'val-trend'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = '—'; el.closest('.stat-card')?.classList.remove('skeleton'); }
  });
}

function renderTimeseriesError() {
  const svg = document.getElementById('timeseries-svg');
  if (!svg) return;
  svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
    fill="var(--text-muted)" font-size="14">No data available</text>`;
}

function renderCategoriesError() {
  const el = document.getElementById('categories-bars');
  if (el) el.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;padding:1rem 0">No data available</p>';
}

function renderRecentError() {
  const tbody = document.getElementById('recent-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="table-loading">No data available</td></tr>';
}

bootstrap();
