/**
 * Log Explorer - Main entry point
 *
 * Wires together:
 * - Filter controls (severity dropdown + debounced search)
 * - VirtualScroller for the log table
 * - Stats display
 */

import { VirtualScroller } from './virtualScroller.js';
import { fetchStats } from './api.js';

const DEBOUNCE_MS = 300;

// DOM elements
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statusText = document.getElementById('status-text');

// Current filter state
let currentSeverity = '';
let currentQ = '';
let debounceTimer = null;

// Request counter for stale-response prevention
let requestSeq = 0;

// Initialize virtual scroller
const scroller = new VirtualScroller({
  scrollContainer,
  spacer: scrollSpacer,
  rowsContainer,
  onStatusChange: (status) => {
    statusText.textContent = status === 'ready'
      ? 'Ready'
      : status === 'loading'
        ? 'Loading...'
        : status;
  },
  onTotalChange: (total) => {
    updateRowCount(total);
  },
});

function updateRowCount(total) {
  const filters = [];
  if (currentSeverity) filters.push(currentSeverity);
  if (currentQ) filters.push(`"${currentQ}"`);

  if (filters.length > 0) {
    rowCountEl.textContent = `${total.toLocaleString()} rows (filtered)`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

async function applyFilters() {
  const seq = ++requestSeq;
  await scroller.setFilters({ severity: currentSeverity, q: currentQ });
  // setFilters handles stale cancellation internally via AbortController
}

// Severity filter change
severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  applyFilters();
});

// Search input with debounce
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQ = searchInput.value.trim();
    applyFilters();
  }, DEBOUNCE_MS);
});

// Load stats for the filter bar badges
async function loadStats() {
  try {
    const stats = await fetchStats();
    // Update severity options with counts
    const options = severityFilter.querySelectorAll('option[value]');
    for (const opt of options) {
      const sev = opt.value;
      if (sev && stats.bySeverity[sev] !== undefined) {
        opt.textContent = `${sev.charAt(0).toUpperCase() + sev.slice(1)} (${stats.bySeverity[sev].toLocaleString()})`;
      }
    }
  } catch (err) {
    console.warn('Could not load stats:', err);
  }
}

// Initial load
async function init() {
  statusText.textContent = 'Connecting to server...';
  rowCountEl.textContent = 'Loading...';

  // Wait for backend to be ready (it may still be seeding)
  let retries = 0;
  const maxRetries = 120; // up to 60s (500ms intervals)

  while (retries < maxRetries) {
    try {
      const resp = await fetch('/api/health');
      if (resp.ok) break;
    } catch (e) {
      // not ready yet
    }
    retries++;
    statusText.textContent = `Waiting for server... (${retries * 0.5}s)`;
    await new Promise(r => setTimeout(r, 500));
  }

  if (retries >= maxRetries) {
    statusText.textContent = 'Error: Could not connect to server';
    rowCountEl.textContent = 'Error';
    return;
  }

  statusText.textContent = 'Loading data...';

  // Load stats and initial data in parallel
  await Promise.all([
    loadStats(),
    applyFilters(),
  ]);
}

init();
