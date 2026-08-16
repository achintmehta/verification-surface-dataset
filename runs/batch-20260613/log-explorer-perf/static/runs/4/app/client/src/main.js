import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ── DOM refs ──────────────────────────────────────────────────────────────
const searchInput      = document.getElementById('search-input');
const searchClear      = document.getElementById('search-clear');
const severityFilter   = document.getElementById('severity-filter');
const rowCountLabel    = document.getElementById('row-count-label');
const loadingIndicator = document.getElementById('loading-indicator');
const viewport         = document.getElementById('scroller-viewport');
const spacer           = document.getElementById('scroller-spacer');
const rowsContainer    = document.getElementById('rows-container');

const badgeAll   = document.getElementById('badge-all');
const badgeDebug = document.getElementById('badge-debug');
const badgeInfo  = document.getElementById('badge-info');
const badgeWarn  = document.getElementById('badge-warn');
const badgeError = document.getElementById('badge-error');

// ── State ─────────────────────────────────────────────────────────────────
let currentSeverity = '';
let currentQ        = '';
let pendingQ        = '';   // what's in the input box (may not be committed yet)

// Debounce timer for search
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 300;

// Abort controller for the initial count fetch on filter change
let countFetchCtrl = null;

// ── Virtual Scroller ──────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  viewport,
  spacer,
  container: rowsContainer,
  onLoadingChange(isLoading) {
    loadingIndicator.hidden = !isLoading;
  },
});

// ── Initialization ────────────────────────────────────────────────────────
async function init() {
  rowCountLabel.textContent = 'Connecting to server…';

  // Load stats for badges
  try {
    const stats = await fetchStats();
    updateBadges(stats);
  } catch (err) {
    console.warn('[main] Could not load stats:', err);
  }

  // Initial load
  await applyFilters();
}

// ── Filter Application ────────────────────────────────────────────────────

/**
 * Called whenever severity or search changes.
 * Fetches the first page (to get total + first rows), then resets the scroller.
 * The scroller seeds its cache with the first page so no second fetch is needed
 * for the initial view.
 */
async function applyFilters() {
  // Cancel any pending count fetch
  if (countFetchCtrl) countFetchCtrl.abort();
  countFetchCtrl = new AbortController();

  rowCountLabel.textContent = 'Loading…';
  loadingIndicator.hidden = false;

  try {
    const result = await fetchLogs(
      { offset: 0, limit: 100, severity: currentSeverity, q: currentQ },
      countFetchCtrl.signal
    );

    const total = result.total;

    // Update row count label
    updateRowCountLabel(total);

    // Reset scroller with new filter state, seeding page 0 into the cache
    scroller.resetWithFirstPage({
      total,
      severity: currentSeverity,
      q: currentQ,
      firstPageRows: result.rows,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[main] applyFilters error:', err);
    rowCountLabel.textContent = 'Error loading logs';
    loadingIndicator.hidden = true;
    showError(err.message);
  } finally {
    if (!countFetchCtrl.signal.aborted) {
      loadingIndicator.hidden = scroller._inflight.size > 0 ? false : true;
    }
  }
}

function updateRowCountLabel(total) {
  if (currentSeverity || currentQ) {
    const parts = [];
    if (currentSeverity) parts.push(`severity=${currentSeverity}`);
    if (currentQ)        parts.push(`"${currentQ}"`);
    rowCountLabel.textContent = `${total.toLocaleString()} rows matching ${parts.join(' + ')}`;
  } else {
    rowCountLabel.textContent = `${total.toLocaleString()} rows total`;
  }
}

function updateBadges(stats) {
  badgeAll.textContent   = formatBadge(stats.total);
  badgeDebug.textContent = formatBadge(stats.debug);
  badgeInfo.textContent  = formatBadge(stats.info);
  badgeWarn.textContent  = formatBadge(stats.warn);
  badgeError.textContent = formatBadge(stats.error);
}

function formatBadge(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function showError(msg) {
  // Remove any existing error banner
  const existing = document.querySelector('.error-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = `Error: ${msg}`;
  viewport.parentElement.insertBefore(banner, viewport);

  setTimeout(() => banner.remove(), 5000);
}

// ── Event Handlers ────────────────────────────────────────────────────────

// Severity filter buttons
severityFilter.addEventListener('click', (e) => {
  const btn = e.target.closest('.sev-btn');
  if (!btn) return;

  const sev = btn.dataset.severity;

  // Update active state
  severityFilter.querySelectorAll('.sev-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  currentSeverity = sev;
  applyFilters();
});

// Search input — debounced
searchInput.addEventListener('input', () => {
  pendingQ = searchInput.value;
  searchClear.hidden = !pendingQ;

  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentQ = pendingQ.trim();
    applyFilters();
  }, SEARCH_DEBOUNCE_MS);
});

// Clear search
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  pendingQ = '';
  searchClear.hidden = true;
  clearTimeout(searchDebounceTimer);
  currentQ = '';
  applyFilters();
});

// ── Boot ──────────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error('[main] init failed:', err);
  rowCountLabel.textContent = 'Failed to connect to server';
});
