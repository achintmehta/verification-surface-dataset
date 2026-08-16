import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ===== DOM refs =====
const scrollerContainer = document.getElementById('scroller-container');
const scrollSpacer      = document.getElementById('scroll-spacer');
const rowsViewport      = document.getElementById('rows-viewport');
const rowCountEl        = document.getElementById('row-count');
const statusBar         = document.getElementById('status-bar');
const severitySelect    = document.getElementById('severity-select');
const searchInput       = document.getElementById('search-input');
const badgeDebug        = document.getElementById('badge-debug');
const badgeInfo         = document.getElementById('badge-info');
const badgeWarn         = document.getElementById('badge-warn');
const badgeError        = document.getElementById('badge-error');

// ===== Constants =====
const ROW_HEIGHT  = 36;   // must match --row-height in CSS
const OVERSCAN    = 15;
const FETCH_LIMIT = 200;
const DEBOUNCE_MS = 250;

// ===== State =====
let currentSeverity = '';
let currentQ        = '';

// Generation counter: incremented on every filter change.
// Responses from a previous generation are discarded.
let generation = 0;

// Abort controller for the current in-flight request
let fetchController = null;

// ===== Virtual Scroller =====
const vs = new VirtualScroller({
  container:     scrollerContainer,
  spacer:        scrollSpacer,
  viewport:      rowsViewport,
  rowHeight:     ROW_HEIGHT,
  overscan:      OVERSCAN,
  onFetchWindow: handleFetchRequest,
});

// ===== Fetch logic =====

/**
 * Called by the virtual scroller when it needs a new window of rows.
 * Cancels any in-flight request and issues a new one.
 */
function handleFetchRequest(offset, limit) {
  // Cancel previous in-flight request
  if (fetchController) {
    fetchController.abort();
  }
  fetchController = new AbortController();

  const myGen = generation;
  const signal = fetchController.signal;

  const params = {
    offset,
    limit: Math.min(limit, FETCH_LIMIT),
    severity: currentSeverity || undefined,
    q: currentQ || undefined,
  };

  setStatus(`Fetching rows ${offset}–${offset + params.limit - 1}…`);

  fetchLogs(params, signal)
    .then((data) => {
      // Discard stale responses
      if (myGen !== generation) return;

      vs.setTotal(data.total);
      vs.setWindow(offset, data.rows);
      updateRowCount(data.total);
      setStatus(
        `Showing rows ${offset + 1}–${offset + data.rows.length} of ${data.total.toLocaleString()} total`
      );
    })
    .catch((err) => {
      if (err.name === 'AbortError') return;
      console.error('[fetch] Error:', err);
      setStatus(`Error: ${err.message}`);
    });
}

/**
 * Reset state, scroll to top, and trigger a fresh fetch from offset 0.
 */
function resetAndFetch() {
  generation++;
  if (fetchController) {
    fetchController.abort();
    fetchController = null;
  }

  vs.scrollToTop();
  vs.setTotal(0);
  vs.setWindow(0, []);
  updateRowCount(0);
  setStatus('Loading…');

  // Immediately request the first window
  handleFetchRequest(0, FETCH_LIMIT);
}

// ===== Filter controls =====

severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  resetAndFetch();
});

// Debounced search — input is never blocked
let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQ = searchInput.value;
    resetAndFetch();
  }, DEBOUNCE_MS);
});

// Badge clicks toggle severity filter
badgeDebug.addEventListener('click', () => toggleSeverity('debug'));
badgeInfo .addEventListener('click', () => toggleSeverity('info'));
badgeWarn .addEventListener('click', () => toggleSeverity('warn'));
badgeError.addEventListener('click', () => toggleSeverity('error'));

function toggleSeverity(sev) {
  const next = currentSeverity === sev ? '' : sev;
  severitySelect.value = next;
  currentSeverity = next;
  resetAndFetch();
}

// ===== Stats =====

async function loadStats() {
  try {
    const stats = await fetchStats();
    badgeDebug.textContent = stats.bySeverity.debug.toLocaleString();
    badgeInfo .textContent = stats.bySeverity.info .toLocaleString();
    badgeWarn .textContent = stats.bySeverity.warn .toLocaleString();
    badgeError.textContent = stats.bySeverity.error.toLocaleString();
  } catch (err) {
    console.warn('[stats] Failed to load stats:', err);
  }
}

// ===== UI helpers =====

function updateRowCount(total) {
  const parts = [];
  if (currentSeverity) parts.push(currentSeverity);
  if (currentQ)        parts.push(`"${currentQ}"`);
  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  rowCountEl.textContent = `${total.toLocaleString()} rows${suffix}`;
}

function setStatus(msg) {
  statusBar.textContent = msg;
}

// ===== Boot =====

async function init() {
  setStatus('Connecting to server…');
  try {
    await loadStats();
    resetAndFetch();
  } catch (err) {
    setStatus(`Failed to connect: ${err.message}`);
  }
}

init();
