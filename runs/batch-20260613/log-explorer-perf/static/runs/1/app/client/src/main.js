/**
 * Log Explorer — main entry point
 *
 * Wires together:
 *  - Filter controls (severity dropdown + debounced search)
 *  - VirtualScroller
 *  - Stats display
 */

import { VirtualScroller } from './virtualScroller.js';
import { fetchStats } from './api.js';

const SEARCH_DEBOUNCE_MS = 300;

// -------------------------------------------------------------------------
// DOM refs
// -------------------------------------------------------------------------
const container    = document.getElementById('scroller-container');
const inner        = document.getElementById('scroller-inner');
const viewport     = document.getElementById('rows-viewport');
const rowCountEl   = document.getElementById('row-count');
const statusTextEl = document.getElementById('status-text');
const severityEl   = document.getElementById('severity-select');
const searchEl     = document.getElementById('search-input');

// -------------------------------------------------------------------------
// Scroller
// -------------------------------------------------------------------------
const scroller = new VirtualScroller({
  container,
  inner,
  viewport,
  onStatus: (msg) => {
    statusTextEl.textContent = msg;
  },
  onRowCount: (rendered, total) => {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  },
});

// -------------------------------------------------------------------------
// Stats
// -------------------------------------------------------------------------
async function loadStats() {
  try {
    const stats = await fetchStats();
    updateSeverityBadges(stats.bySeverity);
  } catch (err) {
    console.warn('[stats] Failed to load stats:', err);
  }
}

function updateSeverityBadges(bySeverity) {
  // Update option labels with counts
  const select = severityEl;
  for (const opt of select.options) {
    if (opt.value && bySeverity[opt.value] !== undefined) {
      const count = bySeverity[opt.value];
      opt.textContent = `${capitalize(opt.value)} (${count.toLocaleString()})`;
    }
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// -------------------------------------------------------------------------
// Filter wiring
// -------------------------------------------------------------------------
let searchDebounceTimer = null;

severityEl.addEventListener('change', () => {
  applyFilters();
});

searchEl.addEventListener('input', () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    applyFilters();
  }, SEARCH_DEBOUNCE_MS);
});

// Prevent form submission on Enter
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

function applyFilters() {
  const severity = severityEl.value;
  const q        = searchEl.value.trim();
  scroller.setFilters({ severity, q });
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------
async function boot() {
  statusTextEl.textContent = 'Connecting to server…';

  try {
    // Initial load — no filters
    await scroller.setFilters({ severity: '', q: '' });
    await loadStats();
  } catch (err) {
    statusTextEl.textContent = `Failed to connect: ${err.message}`;
    console.error('[boot] Error:', err);
  }
}

boot();
