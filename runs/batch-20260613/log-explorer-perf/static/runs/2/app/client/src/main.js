/**
 * Log Explorer — Main entry point
 *
 * Wires together:
 *  - VirtualScroller (DOM virtualization)
 *  - RowCache (windowed API fetching with cancellation)
 *  - Filter controls (severity dropdown + debounced search)
 *  - Stats bar (row count badge)
 */

import { VirtualScroller } from './virtualScroller.js';
import { RowCache } from './rowCache.js';
import { fetchStats } from './api.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const ROW_HEIGHT   = 36;   // px — must match CSS --row-height
const OVERSCAN     = 10;   // extra rows above/below viewport
const DEBOUNCE_MS  = 250;  // search debounce delay

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const scrollerContainer = document.getElementById('scroller-container');
const scrollerInner     = document.getElementById('scroller-inner');
const rowsViewport      = document.getElementById('rows-viewport');
const rowCountEl        = document.getElementById('row-count');
const statusTextEl      = document.getElementById('status-text');
const searchInput       = document.getElementById('search-input');
const searchSpinner     = document.getElementById('search-spinner');
const severitySelect    = document.getElementById('severity-select');

// ─── State ────────────────────────────────────────────────────────────────────
let currentSeverity = '';
let currentQ        = '';
let currentTotal    = 0;
let debounceTimer   = null;
let statsData       = null;

// ─── Row rendering ────────────────────────────────────────────────────────────

const SEV_CLASSES = {
  debug: 'sev-debug',
  info:  'sev-info',
  warn:  'sev-warn',
  error: 'sev-error',
};

function formatTs(isoString) {
  // Fast ISO → "YYYY-MM-DD HH:MM:SS" without locale overhead
  if (!isoString) return '';
  // isoString: "2024-01-15T12:34:56.789Z"
  return isoString.slice(0, 10) + ' ' + isoString.slice(11, 19);
}

function createRowEl(row) {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.dataset.id = row.id;

  const sevClass = SEV_CLASSES[row.severity] || 'sev-debug';

  el.innerHTML =
    `<div class="col-ts">${formatTs(row.ts)}</div>` +
    `<div class="col-sev"><span class="sev-badge ${sevClass}">${escapeHtml(row.severity)}</span></div>` +
    `<div class="col-svc" title="${escapeHtml(row.service)}">${escapeHtml(row.service)}</div>` +
    `<div class="col-msg" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>`;

  return el;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Render rows into the viewport ────────────────────────────────────────────

function renderRows(rows, windowStart) {
  // Recycle: clear and re-fill the viewport
  // For the row count we're dealing with (max ~120 rows in DOM), this is fast.
  rowsViewport.innerHTML = '';

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="icon">🔍</div><div>No log entries match your filters.</div>';
    rowsViewport.appendChild(empty);
    return;
  }

  // Use a DocumentFragment for a single reflow
  const frag = document.createDocumentFragment();
  for (let i = 0; i < rows.length; i++) {
    frag.appendChild(createRowEl(rows[i]));
  }
  rowsViewport.appendChild(frag);
}

// ─── Status / count updates ───────────────────────────────────────────────────

function updateRowCount(total) {
  if (currentSeverity || currentQ) {
    rowCountEl.textContent = `${total.toLocaleString()} of ${(statsData?.total ?? total).toLocaleString()} rows`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

function setStatus(msg) {
  statusTextEl.textContent = msg;
}

// ─── RowCache setup ───────────────────────────────────────────────────────────

const cache = new RowCache({
  onData({ rows, windowStart, total }) {
    renderRows(rows, windowStart);
    updateRowCount(total);
    if (rows.length > 0) {
      setStatus(`Showing rows ${windowStart + 1}–${windowStart + rows.length} of ${total.toLocaleString()}`);
    } else if (total === 0) {
      setStatus(`No results${currentSeverity || currentQ ? ' for current filters' : ''}`);
    } else {
      setStatus(`No rows at offset ${windowStart} (total: ${total.toLocaleString()})`);
    }

    // Update scroller total only if it changed.
    // Defer to avoid synchronous re-entrancy (onData → updateTotal → onWindowChange → onData).
    if (total !== currentTotal) {
      currentTotal = total;
      // Use queueMicrotask to break the synchronous call chain
      queueMicrotask(() => scroller.updateTotal(total));
    }
  },
  onLoading(isLoading) {
    searchSpinner.classList.toggle('active', isLoading);
  },
  onError(msg) {
    setStatus(`Error: ${msg}`);
    console.error('[cache] Fetch error:', msg);
  },
});

// ─── VirtualScroller setup ────────────────────────────────────────────────────

const scroller = new VirtualScroller(
  scrollerContainer,
  scrollerInner,
  rowsViewport,
  {
    rowHeight: ROW_HEIGHT,
    overscan:  OVERSCAN,
    onWindowChange({ startIndex, endIndex }) {
      cache.requestWindow(startIndex, endIndex);
    },
  }
);

// ─── Filter handlers ──────────────────────────────────────────────────────────

function applyFilters() {
  cache.cancel();
  cache.setFilters({ severity: currentSeverity, q: currentQ });
  // Reset currentTotal so onData will always call scroller.updateTotal
  // with the new filtered total (even if it happens to equal the old total).
  currentTotal = -1;
  scroller.scrollToTop();
  // scrollToTop triggers onWindowChange → cache.requestWindow(0, ...)
}

severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQ = searchInput.value;
    applyFilters();
  }, DEBOUNCE_MS);
});

// Prevent form submission on Enter
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

// ─── Initial load ─────────────────────────────────────────────────────────────

async function init() {
  setStatus('Connecting to server…');
  rowCountEl.textContent = 'Loading…';

  try {
    // Load stats for the badge
    statsData = await fetchStats();
    rowCountEl.textContent = `${statsData.total.toLocaleString()} rows`;
    setStatus('Ready');
  } catch (err) {
    console.warn('[init] Stats fetch failed:', err.message);
    setStatus('Warning: could not load stats — retrying via logs endpoint');
    // Stats failed; the first logs fetch will populate total via onData
  }

  // Kick off the initial window fetch.
  // If stats loaded, we set the total now so the scrollbar is sized correctly.
  // If not, we set 0 and let the first onData call update it.
  const initialTotal = statsData?.total ?? 0;
  currentTotal = initialTotal; // pre-set so onData doesn't trigger a redundant updateTotal
  scroller.setTotal(initialTotal);
  // setTotal triggers _compute() which fires onWindowChange → cache.requestWindow
}

init();
