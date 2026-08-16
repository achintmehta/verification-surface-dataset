/**
 * Log Explorer — Virtualized Frontend
 *
 * Architecture:
 * - VirtualScroller manages a fixed pool of DOM rows
 * - Only rows intersecting the viewport (+overscan) exist in the DOM
 * - Scroll position maps to row offset; rows are fetched window-by-window
 * - Debounced search + severity filter; stale responses are discarded via generation counter
 * - Adjacent windows are prefetched to eliminate blank regions during fast scrolling
 */

const API_BASE = 'http://localhost:3001';
const ROW_HEIGHT = 36;          // must match CSS --row-height
const FETCH_LIMIT = 100;        // rows per API request (≤200)
const OVERSCAN = 15;            // extra rows above/below viewport
const DEBOUNCE_MS = 250;        // search debounce delay
const MAX_CACHE_WINDOWS = 20;   // LRU cache size (windows)

// ── DOM refs ──────────────────────────────────────────────────────────────────
const scrollerContainer = document.getElementById('scroller-container');
const scrollerInner     = document.getElementById('scroller-inner');
const rowsViewport      = document.getElementById('rows-viewport');
const rowCountEl        = document.getElementById('row-count');
const statusTextEl      = document.getElementById('status-text');
const severityFilter    = document.getElementById('severity-filter');
const searchInput       = document.getElementById('search-input');

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  total: 0,
  severity: '',
  q: '',
  generation: 0,
  // LRU cache: Map<alignedOffset, { rows, generation, accessTime }>
  cache: new Map(),
  // In-flight fetches: Map<alignedOffset, { promise, controller, generation }>
  inflight: new Map(),
};

let globalTotal = 0; // unfiltered total from /api/stats

// ── Utility ───────────────────────────────────────────────────────────────────
function formatTs(isoStr) {
  // Fast ISO → "YYYY-MM-DD HH:MM:SS.mmm"
  if (!isoStr) return '';
  return isoStr.replace('T', ' ').replace('Z', '').slice(0, 23);
}

function setStatus(msg) {
  statusTextEl.textContent = msg;
}

function setRowCount(total, filtered) {
  if (filtered !== undefined && filtered !== total) {
    rowCountEl.textContent = `${filtered.toLocaleString()} of ${total.toLocaleString()} rows`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

// ── API ───────────────────────────────────────────────────────────────────────
async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
  return res.json();
}

async function fetchLogs(offset, limit, severity, q, signal) {
  const params = new URLSearchParams({ offset, limit });
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);
  const res = await fetch(`${API_BASE}/api/logs?${params}`, { signal });
  if (!res.ok) throw new Error(`Logs fetch failed: ${res.status}`);
  return res.json(); // { total, rows }
}

// ── Cache management ──────────────────────────────────────────────────────────
function alignOffset(offset) {
  return Math.floor(offset / FETCH_LIMIT) * FETCH_LIMIT;
}

function evictOldCacheEntries() {
  if (state.cache.size <= MAX_CACHE_WINDOWS) return;
  // Evict least recently accessed entries
  const entries = [...state.cache.entries()].sort((a, b) => a[1].accessTime - b[1].accessTime);
  const toEvict = entries.slice(0, state.cache.size - MAX_CACHE_WINDOWS);
  for (const [key] of toEvict) {
    state.cache.delete(key);
  }
}

function clearCache() {
  // Abort all in-flight requests for the current generation
  for (const { controller } of state.inflight.values()) {
    try { controller.abort(); } catch {}
  }
  state.inflight.clear();
  state.cache.clear();
}

/**
 * Fetch a window of rows starting at alignedOffset.
 * Returns a promise that resolves to the cache entry or null if stale/aborted.
 */
function fetchWindow(alignedOffset, gen) {
  // Already cached for this generation?
  const cached = state.cache.get(alignedOffset);
  if (cached && cached.generation === gen) {
    cached.accessTime = Date.now();
    return Promise.resolve(cached);
  }

  // Already in-flight for this generation?
  const existing = state.inflight.get(alignedOffset);
  if (existing && existing.generation === gen) {
    return existing.promise;
  }

  // Abort any stale in-flight for this offset
  if (existing) {
    try { existing.controller.abort(); } catch {}
    state.inflight.delete(alignedOffset);
  }

  const controller = new AbortController();
  const promise = fetchLogs(
    alignedOffset,
    FETCH_LIMIT,
    state.severity,
    state.q,
    controller.signal
  ).then(data => {
    if (state.generation !== gen) return null; // stale generation

    const entry = {
      rows: data.rows,
      generation: gen,
      total: data.total,
      accessTime: Date.now(),
    };
    state.cache.set(alignedOffset, entry);
    state.inflight.delete(alignedOffset);
    evictOldCacheEntries();

    // Update total if it changed
    if (data.total !== state.total) {
      state.total = data.total;
      updateScrollHeight();
      updateRowCount();
    }

    return entry;
  }).catch(err => {
    if (err.name !== 'AbortError') {
      console.warn('Fetch error for offset', alignedOffset, ':', err.message);
    }
    state.inflight.delete(alignedOffset);
    return null;
  });

  state.inflight.set(alignedOffset, { promise, controller, generation: gen });
  return promise;
}

/**
 * Get a single row at the given absolute index.
 * Returns the row object or null if not yet available.
 */
function getRowSync(index) {
  const alignedOffset = alignOffset(index);
  const cached = state.cache.get(alignedOffset);
  if (cached && cached.generation === state.generation) {
    cached.accessTime = Date.now();
    return cached.rows[index - alignedOffset] || null;
  }
  return null;
}

// ── Virtual Scroller ──────────────────────────────────────────────────────────
let renderScheduled = false;
let renderRafId = null;

function updateScrollHeight() {
  const totalHeight = Math.max(state.total * ROW_HEIGHT, 1);
  scrollerInner.style.height = `${totalHeight}px`;
}

function updateRowCount() {
  setRowCount(globalTotal, state.total);
}

function getVisibleRange() {
  const scrollTop = scrollerContainer.scrollTop;
  const viewportHeight = scrollerContainer.clientHeight || 600;
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) - 1;

  const start = Math.max(0, firstVisible - OVERSCAN);
  const end = Math.min(state.total - 1, lastVisible + OVERSCAN);

  return { start, end, count: Math.max(0, end - start + 1), scrollTop };
}

// Pool of reusable DOM row elements
const rowPool = [];

function getOrCreateRow() {
  if (rowPool.length > 0) return rowPool.pop();
  const el = document.createElement('div');
  el.className = 'log-row';
  // Pre-create child elements for fast updates
  const ts = document.createElement('div');
  ts.className = 'col-ts';
  const sev = document.createElement('div');
  sev.className = 'col-severity';
  const badge = document.createElement('span');
  badge.className = 'severity-badge';
  sev.appendChild(badge);
  const service = document.createElement('div');
  service.className = 'col-service';
  const message = document.createElement('div');
  message.className = 'col-message';
  el.appendChild(ts);
  el.appendChild(sev);
  el.appendChild(service);
  el.appendChild(message);
  return el;
}

function recycleRow(el) {
  if (el.parentNode) el.parentNode.removeChild(el);
  rowPool.push(el);
}

// Currently rendered rows: Map<rowIndex, DOMElement>
const renderedRows = new Map();

function populateRow(el, row, index) {
  el.children[0].textContent = formatTs(row.ts);
  const badge = el.children[1].children[0];
  badge.textContent = row.severity;
  badge.className = `severity-badge severity-${row.severity}`;
  el.children[2].textContent = row.service;
  el.children[3].textContent = row.message;
  el.dataset.index = index;
}

function populatePlaceholder(el, index) {
  el.children[0].textContent = '…';
  const badge = el.children[1].children[0];
  badge.textContent = '…';
  badge.className = 'severity-badge';
  el.children[2].textContent = '';
  el.children[3].textContent = `Loading…`;
  el.dataset.index = index;
}

async function renderViewport() {
  renderScheduled = false;
  renderRafId = null;

  const gen = state.generation;

  if (state.total === 0) {
    for (const [, el] of renderedRows) recycleRow(el);
    renderedRows.clear();
    rowsViewport.style.transform = 'translateY(0)';
    return;
  }

  const { start, end, count, scrollTop } = getVisibleRange();
  if (count === 0) return;

  // Determine which windows we need
  const windowsNeeded = new Set();
  for (let i = start; i <= end; i += FETCH_LIMIT) {
    windowsNeeded.add(alignOffset(i));
  }
  windowsNeeded.add(alignOffset(end)); // ensure last window is included

  // Kick off fetches for all needed windows (non-blocking)
  const fetchPromises = [];
  for (const windowOffset of windowsNeeded) {
    if (windowOffset < state.total) {
      fetchPromises.push(fetchWindow(windowOffset, gen));
    }
  }

  // Position the viewport
  rowsViewport.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

  // Remove rows no longer in range
  for (const [idx, el] of renderedRows) {
    if (idx < start || idx > end) {
      recycleRow(el);
      renderedRows.delete(idx);
    }
  }

  // Render rows synchronously from cache (may be placeholders)
  let hasPlaceholders = false;
  for (let i = 0; i < count; i++) {
    const rowIndex = start + i;
    let el = renderedRows.get(rowIndex);
    if (!el) {
      el = getOrCreateRow();
      renderedRows.set(rowIndex, el);
      rowsViewport.appendChild(el);
    }

    const row = getRowSync(rowIndex);
    if (row) {
      populateRow(el, row, rowIndex);
    } else {
      populatePlaceholder(el, rowIndex);
      hasPlaceholders = true;
    }
  }

  // Re-order DOM children to match visual order
  const sortedIndices = [...renderedRows.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    rowsViewport.appendChild(renderedRows.get(idx));
  }

  setStatus(`Rows ${start + 1}–${Math.min(end + 1, state.total)} of ${state.total.toLocaleString()}`);

  // If we had placeholders, wait for fetches and re-render
  if (hasPlaceholders && fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
    // Only re-render if still same generation and scroll hasn't moved much
    if (state.generation === gen) {
      scheduleRender();
    }
  }

  // Prefetch adjacent windows
  prefetchAdjacent(start, end, gen);
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  renderRafId = requestAnimationFrame(() => {
    renderViewport();
  });
}

// ── Prefetch adjacent windows ─────────────────────────────────────────────────
function prefetchAdjacent(start, end, gen) {
  // Prefetch the window just after the visible range
  const nextStart = alignOffset(end + 1);
  if (nextStart < state.total && !state.cache.has(nextStart) && !state.inflight.has(nextStart)) {
    fetchWindow(nextStart, gen);
  }

  // Prefetch the window just before the visible range
  const prevStart = alignOffset(Math.max(0, start - FETCH_LIMIT));
  if (prevStart >= 0 && !state.cache.has(prevStart) && !state.inflight.has(prevStart)) {
    fetchWindow(prevStart, gen);
  }
}

// ── Scroll handler ────────────────────────────────────────────────────────────
scrollerContainer.addEventListener('scroll', () => {
  scheduleRender();
}, { passive: true });

// ── Filter handlers ───────────────────────────────────────────────────────────
function applyFilters() {
  const newSeverity = severityFilter.value;
  const newQ = searchInput.value.trim();

  // No-op if nothing changed
  if (newSeverity === state.severity && newQ === state.q) return;

  state.severity = newSeverity;
  state.q = newQ;
  state.generation++;
  clearCache();
  state.total = 0;
  updateScrollHeight();

  // Reset scroll to top
  scrollerContainer.scrollTop = 0;

  // Clear rendered rows
  for (const [, el] of renderedRows) recycleRow(el);
  renderedRows.clear();

  setStatus('Loading…');
  scheduleRender();
}

severityFilter.addEventListener('change', applyFilters);

// Debounced search — input is never blocked
let searchDebounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(applyFilters, DEBOUNCE_MS);
});

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  setStatus('Connecting to server…');

  // Poll until server is ready (handles slow first boot with seeding)
  let stats = null;
  let attempts = 0;
  while (!stats) {
    try {
      stats = await fetchStats();
    } catch {
      attempts++;
      if (attempts > 120) {
        setStatus('Error: Could not connect to server after 2 minutes.');
        return;
      }
      setStatus(`Waiting for server… (attempt ${attempts})`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  globalTotal = stats.total;
  state.total = stats.total;
  state.generation = 1;

  updateScrollHeight();
  updateRowCount();
  setStatus(`Ready — ${stats.total.toLocaleString()} log entries`);

  // Annotate severity dropdown with counts
  const bySeverity = stats.bySeverity || {};
  for (const opt of severityFilter.options) {
    if (opt.value && bySeverity[opt.value] !== undefined) {
      const label = opt.value.charAt(0).toUpperCase() + opt.value.slice(1);
      opt.textContent = `${label} (${bySeverity[opt.value].toLocaleString()})`;
    }
  }

  scheduleRender();
}

init();
