/**
 * Log Explorer — Virtualized Frontend
 *
 * Architecture:
 * - Virtual scroller: only visible rows + overscan exist in DOM
 * - Debounced search (250ms) with stale-response cancellation via sequence numbers
 * - Windowed API calls: fetch only the visible window (100 rows per call)
 * - LRU row cache to avoid redundant fetches while scrolling
 * - Prefetch adjacent windows for smooth scrolling
 */

const API_BASE = 'http://localhost:3001';
const ROW_HEIGHT = 36;          // px — must match CSS --row-height
const FETCH_LIMIT = 100;        // rows fetched per API call (≤200 cap)
const OVERSCAN_ROWS = 10;       // extra rows above/below viewport to render
const DEBOUNCE_MS = 250;        // search debounce delay
const MAX_CACHE_ENTRIES = 10;   // LRU cache size (windows)

// ===== State =====
const state = {
  total: 0,
  severity: '',
  q: '',
  // Monotonically increasing sequence number for stale-response detection
  filterSeq: 0,
  // LRU cache: key → { rows, seq }
  cache: new Map(),
  cacheOrder: [],
  // Stats from /api/stats
  stats: null,
};

// ===== DOM refs =====
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer    = document.getElementById('scroll-spacer');
const rowsContainer   = document.getElementById('rows-container');
const severitySelect  = document.getElementById('severity-select');
const searchInput     = document.getElementById('search-input');
const clearSearch     = document.getElementById('clear-search');
const resultCount     = document.getElementById('result-count');
const corpusBadge     = document.getElementById('corpus-badge');
const loadingOverlay  = document.getElementById('loading-overlay');
const statusText      = document.getElementById('status-text');

// ===== Utilities =====

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatTs(ts) {
  // ts comes as "2024-01-15 14:23:01" or ISO string
  if (!ts) return '';
  return String(ts).replace('T', ' ').slice(0, 19);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function showLoading(show) {
  loadingOverlay.classList.toggle('hidden', !show);
}

// ===== LRU Cache =====

function makeCacheKey(windowOffset, severity, q) {
  return `${severity}|${q}|${windowOffset}`;
}

function cacheGet(key) {
  const entry = state.cache.get(key);
  if (!entry) return null;
  // Move to most-recently-used position
  state.cacheOrder = state.cacheOrder.filter(k => k !== key);
  state.cacheOrder.push(key);
  return entry.rows;
}

function cacheSet(key, rows) {
  if (state.cache.has(key)) {
    state.cacheOrder = state.cacheOrder.filter(k => k !== key);
  } else if (state.cacheOrder.length >= MAX_CACHE_ENTRIES) {
    const evict = state.cacheOrder.shift();
    state.cache.delete(evict);
  }
  state.cache.set(key, { rows });
  state.cacheOrder.push(key);
}

function clearCache() {
  state.cache.clear();
  state.cacheOrder = [];
}

// ===== API =====

async function apiFetchLogs(offset, limit, severity, q, signal) {
  const params = new URLSearchParams({ offset, limit });
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const resp = await fetch(`${API_BASE}/api/logs?${params}`, { signal });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(body.error || resp.statusText);
  }
  return resp.json(); // { total, rows }
}

async function apiFetchStats(signal) {
  const resp = await fetch(`${API_BASE}/api/stats`, { signal });
  if (!resp.ok) throw new Error('Failed to fetch stats');
  return resp.json();
}

// ===== Virtual Scroller Core =====

function getScrollMetrics() {
  const scrollTop      = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;
  const firstVisible   = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount   = Math.ceil(viewportHeight / ROW_HEIGHT) + 1;
  const startRow       = Math.max(0, firstVisible - OVERSCAN_ROWS);
  const endRow         = Math.min(
    Math.max(0, state.total - 1),
    firstVisible + visibleCount + OVERSCAN_ROWS
  );
  return { scrollTop, viewportHeight, firstVisible, visibleCount, startRow, endRow };
}

function updateSpacerHeight() {
  scrollSpacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

/**
 * Render a slice of rows into the DOM.
 * rows: array of row objects
 * windowOffset: the absolute row index of rows[0]
 */
function renderRowSlice(rows, windowOffset) {
  if (state.total === 0 || rows.length === 0) {
    rowsContainer.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <p>No log entries match your filters.</p>
      </div>`;
    rowsContainer.style.transform = 'translateY(0px)';
    return;
  }

  const { startRow, endRow } = getScrollMetrics();

  // Intersect [startRow, endRow] with [windowOffset, windowOffset + rows.length - 1]
  const renderStart = Math.max(startRow, windowOffset);
  const renderEnd   = Math.min(endRow, windowOffset + rows.length - 1);

  if (renderStart > renderEnd) {
    // The fetched window doesn't overlap the viewport — clear and wait
    rowsContainer.innerHTML = '';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (let absIdx = renderStart; absIdx <= renderEnd; absIdx++) {
    const row = rows[absIdx - windowOffset];
    if (!row) continue;

    const div = document.createElement('div');
    div.className = `log-row severity-${row.severity}`;

    div.innerHTML =
      `<div class="col col-ts">${escapeHtml(formatTs(row.ts))}</div>` +
      `<div class="col col-severity"><span class="severity-badge badge-${row.severity}">${row.severity}</span></div>` +
      `<div class="col col-service">${escapeHtml(row.service)}</div>` +
      `<div class="col col-message">${escapeHtml(row.message)}</div>`;

    fragment.appendChild(div);
  }

  rowsContainer.innerHTML = '';
  rowsContainer.appendChild(fragment);
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
}

function updateResultCount() {
  const total = state.total;
  const grandTotal = state.stats?.total ?? total;
  if (state.severity || state.q) {
    resultCount.textContent = `${total.toLocaleString()} of ${grandTotal.toLocaleString()} rows`;
  } else {
    resultCount.textContent = `${total.toLocaleString()} rows`;
  }
}

// ===== Fetch + Render Orchestration =====

// Track the current filter sequence so stale responses are discarded
let activeAbortController = null;

async function fetchAndRender(filterSeq) {
  // Abort any previous in-flight request
  if (activeAbortController) {
    activeAbortController.abort();
  }
  const controller = new AbortController();
  activeAbortController = controller;

  const { startRow } = getScrollMetrics();
  const { severity, q } = state;

  // Align to window boundary
  const windowOffset = Math.floor(startRow / FETCH_LIMIT) * FETCH_LIMIT;
  const key = makeCacheKey(windowOffset, severity, q);

  // Check cache first
  const cached = cacheGet(key);
  if (cached) {
    if (filterSeq !== state.filterSeq) return; // stale
    renderRowSlice(cached, windowOffset);
    setStatus(buildStatusMsg(windowOffset, cached.length, false));
    // Prefetch adjacent window in background
    prefetchAdjacent(windowOffset, filterSeq);
    return;
  }

  showLoading(true);

  try {
    const result = await apiFetchLogs(windowOffset, FETCH_LIMIT, severity, q, controller.signal);

    // Stale check
    if (filterSeq !== state.filterSeq || controller.signal.aborted) return;

    // Update total
    if (result.total !== state.total) {
      state.total = result.total;
      updateSpacerHeight();
      updateResultCount();
    }

    cacheSet(key, result.rows);
    renderRowSlice(result.rows, windowOffset);
    setStatus(buildStatusMsg(windowOffset, result.rows.length, false));

    // Prefetch adjacent window
    prefetchAdjacent(windowOffset, filterSeq);

  } catch (err) {
    if (err.name === 'AbortError') return;
    if (filterSeq !== state.filterSeq) return;
    console.error('Fetch error:', err);
    setStatus(`Error: ${err.message}`);
  } finally {
    if (filterSeq === state.filterSeq && !controller.signal.aborted) {
      showLoading(false);
    }
  }
}

function buildStatusMsg(windowOffset, rowCount, fromCache) {
  const end = Math.min(windowOffset + rowCount, state.total);
  const cached = fromCache ? ' (cached)' : '';
  return `Rows ${(windowOffset + 1).toLocaleString()}–${end.toLocaleString()} of ${state.total.toLocaleString()}${cached}`;
}

// Prefetch the next window silently
async function prefetchAdjacent(currentWindowOffset, filterSeq) {
  const { severity, q } = state;
  const nextOffset = currentWindowOffset + FETCH_LIMIT;
  if (nextOffset >= state.total) return;

  const key = makeCacheKey(nextOffset, severity, q);
  if (cacheGet(key)) return; // already cached

  try {
    const result = await apiFetchLogs(nextOffset, FETCH_LIMIT, severity, q, null);
    if (filterSeq !== state.filterSeq) return;
    cacheSet(key, result.rows);
  } catch {
    // Prefetch failures are silent
  }
}

// ===== Filter Application =====

async function applyFilters() {
  const filterSeq = ++state.filterSeq;

  // Reset scroll position
  scrollContainer.scrollTop = 0;

  // Clear cache since filters changed
  clearCache();
  state.total = 0;
  updateSpacerHeight();

  showLoading(true);

  const { severity, q } = state;

  try {
    const result = await apiFetchLogs(0, FETCH_LIMIT, severity, q, null);

    if (filterSeq !== state.filterSeq) return; // stale

    state.total = result.total;
    updateSpacerHeight();
    updateResultCount();

    const key = makeCacheKey(0, severity, q);
    cacheSet(key, result.rows);

    renderRowSlice(result.rows, 0);
    setStatus(`Loaded ${state.total.toLocaleString()} rows`);

  } catch (err) {
    if (filterSeq !== state.filterSeq) return;
    console.error('Filter apply error:', err);
    setStatus(`Error: ${err.message}`);
  } finally {
    if (filterSeq === state.filterSeq) {
      showLoading(false);
    }
  }
}

// ===== Scroll Handler =====

let scrollRafId = null;

function onScroll() {
  if (scrollRafId) cancelAnimationFrame(scrollRafId);
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    fetchAndRender(state.filterSeq);
  });
}

// ===== Event Listeners =====

severitySelect.addEventListener('change', () => {
  state.severity = severitySelect.value;
  applyFilters();
});

const debouncedSearch = debounce(() => {
  state.q = searchInput.value.trim();
  applyFilters();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', () => {
  clearSearch.classList.toggle('visible', searchInput.value.length > 0);
  debouncedSearch();
});

clearSearch.addEventListener('click', () => {
  searchInput.value = '';
  clearSearch.classList.remove('visible');
  state.q = '';
  applyFilters();
});

scrollContainer.addEventListener('scroll', onScroll, { passive: true });

// Re-render on viewport resize
const resizeObserver = new ResizeObserver(() => {
  fetchAndRender(state.filterSeq);
});
resizeObserver.observe(scrollContainer);

// ===== Initialization =====

async function init() {
  setStatus('Connecting to server…');
  showLoading(true);

  // Poll until server is ready (handles seeding delay)
  const maxWaitMs = 65_000;
  const pollInterval = 500;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const stats = await apiFetchStats(null);
      state.stats = stats;
      corpusBadge.textContent = `${stats.total.toLocaleString()} entries`;
      setStatus(`Connected — ${stats.total.toLocaleString()} log entries`);
      break;
    } catch {
      setStatus('Waiting for server (seeding may be in progress)…');
      await new Promise(r => setTimeout(r, pollInterval));
    }
  }

  if (!state.stats) {
    setStatus('Could not connect to server. Is the backend running?');
    showLoading(false);
    return;
  }

  await applyFilters();
}

init();
