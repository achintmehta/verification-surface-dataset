/**
 * Log Explorer — Main Application
 *
 * Wires together:
 *  - Filter controls (severity dropdown + debounced search)
 *  - VirtualScroller (DOM virtualization)
 *  - API client (windowed fetches with abort/cancel)
 *  - Stats bar (severity badges with counts)
 */

import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ---- Constants ----
const DEBOUNCE_MS  = 250;
const FETCH_LIMIT  = 100;

// ---- State ----
let currentSeverity = '';
let currentQuery    = '';

// AbortController for in-flight log requests (cancel stale)
let logsAbortController = null;

// Monotonic request counter — discard responses from older requests
let requestSeq = 0;

// ---- DOM refs ----
const severitySelect    = /** @type {HTMLSelectElement} */ (document.getElementById('severity-select'));
const searchInput       = /** @type {HTMLInputElement}  */ (document.getElementById('search-input'));
const searchClear       = document.getElementById('search-clear');
const rowCountEl        = document.getElementById('row-count');
const severityBadgesEl  = document.getElementById('severity-badges');
const statusText        = document.getElementById('status-text');
const scrollerContainer = document.getElementById('scroller-container');
const scrollerInner     = document.getElementById('scroller-inner');
const rowsViewport      = document.getElementById('rows-viewport');

// ---- Virtual scroller ----
const scroller = new VirtualScroller({
  container: scrollerContainer,
  inner:     scrollerInner,
  viewport:  rowsViewport,
  onWindowChange: (offset, limit) => {
    loadWindow(offset, limit);
  },
});

// ---- Debounce utility ----
function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

// ---- Filter change handler ----
function onFiltersChanged() {
  currentSeverity = severitySelect.value;
  currentQuery    = searchInput.value;

  // Reset scroller state and scroll to top
  scroller.scrollToTop();
  scroller.setTotal(0);

  // Cancel any in-flight request
  if (logsAbortController) {
    logsAbortController.abort();
    logsAbortController = null;
  }

  // Fetch total + first window
  loadWindow(0, FETCH_LIMIT);
}

// ---- Load a window of rows ----
async function loadWindow(offset, limit) {
  // Cancel any in-flight request
  if (logsAbortController) {
    logsAbortController.abort();
  }
  logsAbortController = new AbortController();
  const signal = logsAbortController.signal;

  // Capture sequence number for this request
  const seq = ++requestSeq;

  setStatus('Fetching…');

  try {
    const t0   = performance.now();
    const data = await fetchLogs(
      { offset, limit, severity: currentSeverity, q: currentQuery },
      signal
    );
    const elapsed = (performance.now() - t0).toFixed(0);

    // Discard stale (out-of-order) responses
    if (seq !== requestSeq) return;

    // Update scroller total (resizes scroll height)
    scroller.setTotal(data.total);

    // Provide rows to scroller
    scroller.setRows(data.rows, offset);

    // Update UI counters
    updateRowCount(data.total);
    setStatus(buildStatusMsg(data, offset, elapsed));

    // Show empty state if no results
    if (data.total === 0) {
      showEmptyState();
    } else {
      hideEmptyState();
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // cancelled — ignore
    console.error('[app] Fetch error:', err);
    setStatus(`Error: ${err.message}`);
  }
}

// ---- Stats ----
async function loadStats() {
  try {
    const stats = await fetchStats();
    renderSeverityBadges(stats.bySeverity);
  } catch (err) {
    console.error('[app] Stats error:', err);
  }
}

function renderSeverityBadges(bySeverity) {
  const severities = ['debug', 'info', 'warn', 'error'];
  severityBadgesEl.innerHTML = severities.map(sev => `
    <span class="sev-badge ${sev}" title="${sev}: ${bySeverity[sev].toLocaleString()} rows">
      ${sev} <strong>${formatCount(bySeverity[sev])}</strong>
    </span>
  `).join('');
}

// ---- Empty state ----
let emptyStateEl = null;

function showEmptyState() {
  if (!emptyStateEl) {
    emptyStateEl = document.createElement('div');
    emptyStateEl.className = 'empty-state';
    emptyStateEl.innerHTML = `
      <div class="empty-state-icon">🔍</div>
      <div>No log entries match your filters</div>
    `;
  }
  if (!rowsViewport.contains(emptyStateEl)) {
    rowsViewport.style.height = '200px';
    rowsViewport.style.top    = '0px';
    rowsViewport.innerHTML    = '';
    rowsViewport.appendChild(emptyStateEl);
  }
}

function hideEmptyState() {
  if (emptyStateEl && rowsViewport.contains(emptyStateEl)) {
    rowsViewport.removeChild(emptyStateEl);
  }
}

// ---- UI helpers ----
function updateRowCount(total) {
  const hasFilter = currentSeverity || (currentQuery && currentQuery.trim());
  const label = hasFilter
    ? `${total.toLocaleString()} matching`
    : `${total.toLocaleString()} rows`;
  rowCountEl.textContent = label;
}

function buildStatusMsg(data, offset, elapsed) {
  const parts = [
    `${data.rows.length} rows in ${elapsed}ms`,
    `offset ${offset.toLocaleString()}`,
    `total ${data.total.toLocaleString()}`,
  ];
  if (currentSeverity) parts.push(`severity=${currentSeverity}`);
  if (currentQuery && currentQuery.trim()) parts.push(`q="${currentQuery.trim()}"`);
  return parts.join(' · ');
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function formatCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---- Event listeners ----
severitySelect.addEventListener('change', onFiltersChanged);

const debouncedSearch = debounce(onFiltersChanged, DEBOUNCE_MS);

searchInput.addEventListener('input', () => {
  // Show/hide clear button immediately (not debounced — never blocks input)
  searchClear.classList.toggle('visible', searchInput.value.length > 0);
  // Debounce the actual search
  debouncedSearch();
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.remove('visible');
  onFiltersChanged();
});

// Prevent form submission on Enter — fire immediately
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    debouncedSearch.cancel();
    onFiltersChanged();
  }
});

// ---- Boot ----
async function init() {
  setStatus('Connecting to server…');
  rowCountEl.textContent = 'Loading…';

  // Load stats (badges) in parallel with first window
  loadStats();

  // Load first window
  loadWindow(0, FETCH_LIMIT);
}

init();
