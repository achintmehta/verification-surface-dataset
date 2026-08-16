import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ===== DOM References =====
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer    = document.getElementById('scroll-spacer');
const virtualRows     = document.getElementById('virtual-rows');
const loadingOverlay  = document.getElementById('loading-overlay');
const emptyState      = document.getElementById('empty-state');
const resultText      = document.getElementById('result-text');
const corpusInfo      = document.getElementById('corpus-info');

const severitySelect  = document.getElementById('severity-select');
const searchInput     = document.getElementById('search-input');
const clearSearchBtn  = document.getElementById('clear-search');

const countAll   = document.getElementById('count-all');
const countError = document.getElementById('count-error');
const countWarn  = document.getElementById('count-warn');
const countInfo  = document.getElementById('count-info');
const countDebug = document.getElementById('count-debug');

// ===== State =====
let currentSeverity = '';
let currentQ = '';
let currentTotal = 0;
let isInitialized = false;

// Debounce for search
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 300;

// Abort controller for filter-change fetches
let filterFetchController = null;

// ===== Virtual Scroller =====
const scroller = new VirtualScroller({
  container: scrollContainer,
  spacer: scrollSpacer,
  rowsContainer: virtualRows,
  onLoadingChange: (isLoading) => {
    // Only show overlay during initial load, not during scroll
    if (!isInitialized) {
      loadingOverlay.hidden = !isLoading;
    }
  },
});

// ===== Stats =====
async function loadStats() {
  try {
    const stats = await fetchStats();
    countAll.textContent   = stats.total.toLocaleString();
    countError.textContent = stats.bySeverity.error.toLocaleString();
    countWarn.textContent  = stats.bySeverity.warn.toLocaleString();
    countInfo.textContent  = stats.bySeverity.info.toLocaleString();
    countDebug.textContent = stats.bySeverity.debug.toLocaleString();
    corpusInfo.textContent = `${stats.total.toLocaleString()} total log entries`;
  } catch (err) {
    console.error('[stats] Failed to load stats:', err);
    corpusInfo.textContent = 'Failed to load stats';
  }
}

// ===== Filter Application =====
async function applyFilters() {
  const severity = currentSeverity;
  const q = currentQ;

  // Cancel any in-flight filter fetch
  if (filterFetchController) {
    filterFetchController.abort();
  }
  filterFetchController = new AbortController();
  const signal = filterFetchController.signal;

  // Show loading state
  loadingOverlay.hidden = false;
  emptyState.hidden = true;
  resultText.textContent = 'Loading...';

  try {
    // Fetch just the first window to get the total count
    const result = await fetchLogs({ offset: 0, limit: 100, severity, q }, signal);

    if (signal.aborted) return; // stale response

    currentTotal = result.total;

    // Update result count display
    updateResultCount(result.total, severity, q);

    // Show/hide empty state
    if (result.total === 0) {
      emptyState.hidden = false;
      loadingOverlay.hidden = true;
      scroller.setParams({ total: 0, severity, q });
      return;
    }

    emptyState.hidden = true;
    loadingOverlay.hidden = true;
    isInitialized = true;

    // Update scroller params (resets scroll, clears cache)
    scroller.setParams({ total: result.total, severity, q });

    // Prime the cache with the first window's data AFTER setParams clears it
    scroller.cache.set(0, result.rows);
    scroller._render();

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[applyFilters] Error:', err);
    loadingOverlay.hidden = true;
    resultText.textContent = 'Error loading logs';
  }
}

function updateResultCount(total, severity, q) {
  const parts = [];
  if (severity) parts.push(`severity=${severity}`);
  if (q) parts.push(`q="${q}"`);

  if (parts.length === 0) {
    resultText.textContent = `${total.toLocaleString()} rows`;
  } else {
    resultText.textContent = `${total.toLocaleString()} rows matching (${parts.join(', ')})`;
  }
}

// ===== Event Handlers =====
severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

searchInput.addEventListener('input', () => {
  const val = searchInput.value;
  clearSearchBtn.hidden = val.length === 0;

  // Debounce
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentQ = val;
    applyFilters();
  }, SEARCH_DEBOUNCE_MS);
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearSearchBtn.hidden = true;
  currentQ = '';
  clearTimeout(searchDebounceTimer);
  applyFilters();
});

// Stats badge clicks set severity filter
document.getElementById('badge-all').addEventListener('click', () => {
  severitySelect.value = '';
  currentSeverity = '';
  applyFilters();
});

['error', 'warn', 'info', 'debug'].forEach(sev => {
  document.getElementById(`badge-${sev}`).addEventListener('click', () => {
    severitySelect.value = sev;
    currentSeverity = sev;
    applyFilters();
  });
});

// ===== Initialization =====
async function init() {
  loadingOverlay.hidden = false;

  // Load stats in parallel with initial log fetch
  await Promise.all([
    loadStats(),
    applyFilters(),
  ]);
}

init().catch(err => {
  console.error('[init] Fatal error:', err);
  loadingOverlay.hidden = true;
  resultText.textContent = 'Failed to connect to server';
});
