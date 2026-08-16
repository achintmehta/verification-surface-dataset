/**
 * Log Explorer – Main Application
 *
 * Wires together:
 * - Filter controls (severity dropdown + debounced search)
 * - Stats bar (per-severity counts)
 * - Virtual scroller (windowed rendering)
 * - API client (windowed queries with AbortController for stale-response prevention)
 */

import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ============================================================
// Constants
// ============================================================

const DEBOUNCE_MS  = 300;
const FETCH_LIMIT  = 100;

// ============================================================
// DOM References
// ============================================================

const scrollContainer = /** @type {HTMLElement} */ (document.getElementById('scroll-container'));
const scrollSpacer    = /** @type {HTMLElement} */ (document.getElementById('scroll-spacer'));
const virtualRows     = /** @type {HTMLElement} */ (document.getElementById('virtual-rows'));
const rowCountEl      = /** @type {HTMLElement} */ (document.getElementById('row-count'));
const loadingOverlay  = /** @type {HTMLElement} */ (document.getElementById('loading-overlay'));
const emptyState      = /** @type {HTMLElement} */ (document.getElementById('empty-state'));
const severityFilter  = /** @type {HTMLSelectElement} */ (document.getElementById('severity-filter'));
const searchInput     = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
const searchClear     = /** @type {HTMLButtonElement} */ (document.getElementById('search-clear'));
const statError       = /** @type {HTMLElement} */ (document.getElementById('stat-error'));
const statWarn        = /** @type {HTMLElement} */ (document.getElementById('stat-warn'));
const statInfo        = /** @type {HTMLElement} */ (document.getElementById('stat-info'));
const statDebug       = /** @type {HTMLElement} */ (document.getElementById('stat-debug'));

// ============================================================
// Application State
// ============================================================

const state = {
  severity: /** @type {string} */ (''),
  q:        /** @type {string} */ (''),
  total:    0,
};

// Monotonically increasing request ID — ensures stale responses are discarded
let requestSeq = 0;

// AbortController for the current in-flight log request
let currentAbortController = /** @type {AbortController|null} */ (null);

// ============================================================
// Utilities
// ============================================================

function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function formatTs(tsStr) {
  const d = new Date(tsStr);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCount(n) {
  return n.toLocaleString();
}

function fmtBadge(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ============================================================
// Row Renderer
// ============================================================

const SEV_CLASS = { error: 'sev-error', warn: 'sev-warn', info: 'sev-info', debug: 'sev-debug' };
const SEV_LABEL = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' };

function renderRow(el, row) {
  // Reset class list
  el.className = `log-row ${SEV_CLASS[row.severity] ?? ''}`;

  el.innerHTML =
    `<div class="col col-ts">${escapeHtml(formatTs(row.ts))}</div>` +
    `<div class="col col-severity">${SEV_LABEL[row.severity] ?? row.severity}</div>` +
    `<div class="col col-service">${escapeHtml(row.service)}</div>` +
    `<div class="col col-message">${escapeHtml(row.message)}</div>`;
}

// ============================================================
// Virtual Scroller
// ============================================================

const scroller = new VirtualScroller({
  scrollContainer,
  spacer:         scrollSpacer,
  rowsContainer:  virtualRows,
  onWindowChange: (offset, limit) => fetchWindow(offset, limit),
  renderRow,
});

// ============================================================
// Data Fetching
// ============================================================

/**
 * Fetch a window of rows. Cancels any in-flight request.
 * Uses a sequence number to discard responses that arrive out of order.
 */
async function fetchWindow(offset, limit) {
  // Cancel previous in-flight request
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  // Capture sequence number for this request
  const seq = ++requestSeq;

  setLoading(true);

  try {
    const data = await fetchLogs(
      {
        offset,
        limit,
        severity: state.severity || null,
        q:        state.q        || null,
      },
      signal
    );

    // Discard if a newer request has been issued
    if (seq !== requestSeq) return;
    if (signal.aborted)     return;

    state.total = data.total;
    updateRowCount(data.total);
    showEmptyState(data.total === 0);
    scroller.setRows(data.rows, data.total, offset);
  } catch (err) {
    if (err.name === 'AbortError') return; // expected — stale request cancelled
    console.error('[fetchWindow] Error:', err);
    // Show error state without crashing
    updateRowCount(0);
    showEmptyState(true);
  } finally {
    // Only clear loading if this is still the latest request
    if (seq === requestSeq) {
      setLoading(false);
    }
  }
}

/**
 * Reset scroll to top and reload from offset 0 with current filters.
 */
function reloadFromTop() {
  scroller.reset();
  showEmptyState(false);
  fetchWindow(0, FETCH_LIMIT);
}

// ============================================================
// Stats
// ============================================================

async function loadStats() {
  try {
    const stats = await fetchStats();
    statError.textContent = `E: ${fmtBadge(stats.bySeverity.error)}`;
    statWarn.textContent  = `W: ${fmtBadge(stats.bySeverity.warn)}`;
    statInfo.textContent  = `I: ${fmtBadge(stats.bySeverity.info)}`;
    statDebug.textContent = `D: ${fmtBadge(stats.bySeverity.debug)}`;
  } catch (err) {
    console.warn('[loadStats] Failed:', err);
  }
}

// ============================================================
// UI Helpers
// ============================================================

function setLoading(loading) {
  if (loading) {
    loadingOverlay.classList.remove('hidden');
  } else {
    loadingOverlay.classList.add('hidden');
  }
}

function updateRowCount(total) {
  const parts = [`${fmtCount(total)} rows`];
  if (state.severity) parts.push(`[${state.severity}]`);
  if (state.q)        parts.push(`matching "${state.q}"`);
  rowCountEl.textContent = parts.join(' ');
}

function showEmptyState(show) {
  emptyState.style.display = show ? 'flex' : 'none';
}

// ============================================================
// Event Handlers
// ============================================================

severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  reloadFromTop();
});

const handleSearchInput = debounce(() => {
  state.q = searchInput.value;
  searchClear.classList.toggle('visible', state.q.length > 0);
  reloadFromTop();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', handleSearchInput);

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  state.q = '';
  searchClear.classList.remove('visible');
  reloadFromTop();
});

// Re-render on window resize (viewport height may have changed)
window.addEventListener('resize', () => {
  scroller.refresh();
});

// ============================================================
// Boot
// ============================================================

async function boot() {
  // Load stats in background (non-blocking)
  loadStats();

  // Initial data load
  await fetchWindow(0, FETCH_LIMIT);
}

boot();
