/**
 * Log Explorer - Main entry point
 *
 * Wires together:
 * - Filter controls (severity dropdown, debounced search)
 * - VirtualScroller (virtualized row rendering)
 * - Stats display (row count badge)
 */

import { VirtualScroller } from './virtualScroller.js';
import { fetchStats } from './api.js';

// ===== DOM References =====
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const virtualRows = document.getElementById('virtual-rows');
const rowCountEl = document.getElementById('row-count');
const statusText = document.getElementById('status-text');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');

// ===== State =====
let currentSeverity = '';
let currentQ = '';
let debounceTimer = null;
let statsAbortController = null;

// ===== Virtual Scroller =====
const scroller = new VirtualScroller({
  container: scrollContainer,
  spacer: scrollSpacer,
  rowsContainer: virtualRows,
  onStatusChange: handleStatusChange,
});

// ===== Status Handler =====
function handleStatusChange(status, message) {
  switch (status) {
    case 'loading':
      statusText.textContent = 'Loading...';
      break;
    case 'ready': {
      const total = scroller.getTotal();
      const offset = scroller.getVisibleOffset();
      const hasFilter = currentSeverity || currentQ;
      const filterNote = hasFilter ? ' (filtered)' : '';
      statusText.textContent = `Showing from row ${(offset + 1).toLocaleString()} · ${total.toLocaleString()} total${filterNote}`;
      updateRowCount(total, hasFilter);
      break;
    }
    case 'error':
      statusText.textContent = `Error: ${message}`;
      break;
  }
}

function updateRowCount(total, hasFilter) {
  if (hasFilter) {
    rowCountEl.textContent = `${total.toLocaleString()} matching`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

// ===== Scroll position status update =====
scrollContainer.addEventListener('scroll', () => {
  const scrollTop = scrollContainer.scrollTop;
  const rowOffset = Math.floor(scrollTop / 36); // ROW_HEIGHT
  const total = scroller.getTotal();
  if (total > 0) {
    const hasFilter = currentSeverity || currentQ;
    const filterNote = hasFilter ? ' (filtered)' : '';
    statusText.textContent = `Row ${(rowOffset + 1).toLocaleString()} of ${total.toLocaleString()}${filterNote}`;
  }
}, { passive: true });

// ===== Filter Handlers =====
severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  applyFilters();
});

searchInput.addEventListener('input', () => {
  const val = searchInput.value;
  searchClear.classList.toggle('visible', val.length > 0);

  // Debounce: wait 300ms after last keystroke before firing query
  // Input itself is never blocked — only the query is deferred
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQ = val.trim();
    applyFilters();
  }, 300);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.remove('visible');
  currentQ = '';
  clearTimeout(debounceTimer);
  applyFilters();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    searchClear.classList.remove('visible');
    currentQ = '';
    clearTimeout(debounceTimer);
    applyFilters();
  }
});

function applyFilters() {
  scroller.setFilters({ severity: currentSeverity, q: currentQ });
}

// ===== Stats =====
async function loadStats() {
  if (statsAbortController) statsAbortController.abort();
  statsAbortController = new AbortController();

  try {
    const stats = await fetchStats(statsAbortController.signal);
    updateSeverityOptions(stats.bySeverity);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('Failed to load stats:', err);
    }
  }
}

function updateSeverityOptions(bySeverity) {
  const options = severityFilter.querySelectorAll('option[value]');
  options.forEach((opt) => {
    const val = opt.value;
    if (val && bySeverity[val] !== undefined) {
      const count = bySeverity[val].toLocaleString();
      const label = val.charAt(0).toUpperCase() + val.slice(1);
      opt.textContent = `${label} (${count})`;
    }
  });
}

// ===== Initialization =====
async function init() {
  statusText.textContent = 'Connecting to server...';
  rowCountEl.textContent = 'Loading...';

  // Wait for backend to be ready (may still be seeding on first boot)
  let retries = 0;
  const maxRetries = 120; // up to 60s (500ms intervals)

  while (retries < maxRetries) {
    try {
      const resp = await fetch('/health');
      if (resp.ok) break;
    } catch (e) {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
    retries++;
    if (retries % 4 === 0) {
      statusText.textContent = `Waiting for server... (${(retries * 0.5).toFixed(0)}s)`;
    }
  }

  if (retries >= maxRetries) {
    statusText.textContent = 'Server connection failed. Please refresh.';
    rowCountEl.textContent = 'Error';
    return;
  }

  // Load initial data
  try {
    await scroller.setFilters({ severity: '', q: '' });
    await loadStats();
  } catch (err) {
    console.error('Initialization error:', err);
    statusText.textContent = `Initialization error: ${err.message}`;
  }
}

init();
