// Log Explorer - Virtualized Log Table
// Only visible rows (plus overscan) exist in the DOM; rows are recycled.

const API_BASE = '/api';
const ROW_HEIGHT = 32;       // Must match CSS --row-height
const OVERSCAN = 10;         // Extra rows rendered above/below viewport
const PAGE_SIZE = 200;       // Rows fetched per API call (max allowed by server)
const DEBOUNCE_MS = 250;     // Debounce for text search
const MAX_CACHE_PAGES = 20;  // Max pages to keep in cache before evicting old ones

// ===== State =====
const state = {
  total: 0,
  severity: '',
  query: '',
  filterEpoch: 0,  // Incremented on every filter change; used to discard stale responses
};

// Page cache: Map<pageIndex, { rows: [], epoch: number }>
// pageIndex = Math.floor(offset / PAGE_SIZE)
const pageCache = new Map();
const pendingPages = new Map(); // pageIndex -> Promise

// ===== DOM refs =====
const scrollContainer = document.getElementById('virtual-scroll');
const scrollSpacer = document.getElementById('scroll-spacer');
const rowPool = document.getElementById('row-pool');
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// Loading indicator
const loadingEl = document.createElement('div');
loadingEl.className = 'loading-indicator';
loadingEl.textContent = 'Loading...';
document.body.appendChild(loadingEl);
let activeRequests = 0;
function showLoading() { activeRequests++; loadingEl.classList.add('visible'); }
function hideLoading() { activeRequests = Math.max(0, activeRequests - 1); if (activeRequests === 0) loadingEl.classList.remove('visible'); }

// ===== API Layer =====

async function apiFetchLogs(offset, limit, severity, query) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (query) params.set('q', query);

  const resp = await fetch(`${API_BASE}/logs?${params}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json(); // { total, rows }
}

async function apiFetchStats() {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ===== Cache =====

function clearCache() {
  pageCache.clear();
  pendingPages.clear();
}

function getCachedRow(globalIndex) {
  const pageIdx = Math.floor(globalIndex / PAGE_SIZE);
  const page = pageCache.get(pageIdx);
  if (!page || page.epoch !== state.filterEpoch) return null;
  const localIdx = globalIndex - pageIdx * PAGE_SIZE;
  return page.rows[localIdx] || null;
}

function evictOldPages() {
  if (pageCache.size <= MAX_CACHE_PAGES) return;
  // Evict oldest by insertion order (Map iterates in insertion order)
  const toEvict = pageCache.size - MAX_CACHE_PAGES;
  let evicted = 0;
  for (const key of pageCache.keys()) {
    if (evicted >= toEvict) break;
    pageCache.delete(key);
    evicted++;
  }
}

// Fetch a page if not cached or pending. Returns a promise that resolves when
// the page is cached (or immediately if already cached).
function ensurePageLoaded(pageIdx) {
  const epoch = state.filterEpoch;

  // Already cached for current epoch?
  const cached = pageCache.get(pageIdx);
  if (cached && cached.epoch === epoch) return Promise.resolve();

  // Already being fetched for current epoch?
  const pending = pendingPages.get(pageIdx);
  if (pending && pending.epoch === epoch) return pending.promise;

  const offset = pageIdx * PAGE_SIZE;
  const limit = PAGE_SIZE;

  showLoading();

  const promise = apiFetchLogs(offset, limit, state.severity, state.query)
    .then((data) => {
      // Only store if epoch matches (filters didn't change)
      if (state.filterEpoch === epoch) {
        pageCache.set(pageIdx, { rows: data.rows, epoch });
        // Update total from latest response
        state.total = data.total;
        updateSpacerHeight();
        updateRowCount();
        evictOldPages();
        renderVisibleRows(); // Re-render to show newly loaded data
      }
    })
    .catch((err) => {
      console.error(`Failed to fetch page ${pageIdx}:`, err);
    })
    .finally(() => {
      pendingPages.delete(pageIdx);
      hideLoading();
    });

  pendingPages.set(pageIdx, { promise, epoch });
  return promise;
}

// ===== Rendering =====

// We maintain a pool of DOM elements. We create/destroy as needed to match
// the visible window size, and reposition + update content on each render.
let poolElements = [];

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';

  const tsCol = document.createElement('div');
  tsCol.className = 'col col-ts';

  const sevCol = document.createElement('div');
  sevCol.className = 'col col-severity';

  const svcCol = document.createElement('div');
  svcCol.className = 'col col-service';

  const msgCol = document.createElement('div');
  msgCol.className = 'col col-message';

  row.appendChild(tsCol);
  row.appendChild(sevCol);
  row.appendChild(svcCol);
  row.appendChild(msgCol);

  return row;
}

function formatTimestamp(ts) {
  // ts comes as ISO string or similar from PGLite
  const d = new Date(ts);
  // Format: YYYY-MM-DD HH:MM:SS
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}

function updateRowElement(el, data, globalIndex) {
  const tsEl = el.children[0];
  const sevEl = el.children[1];
  const svcEl = el.children[2];
  const msgEl = el.children[3];

  if (data) {
    tsEl.textContent = formatTimestamp(data.ts);
    sevEl.textContent = data.severity.toUpperCase();
    sevEl.className = `col col-severity severity-${data.severity}`;
    svcEl.textContent = data.service;
    msgEl.textContent = data.message;
  } else {
    tsEl.textContent = '';
    sevEl.textContent = '';
    sevEl.className = 'col col-severity';
    svcEl.textContent = '';
    msgEl.textContent = 'Loading...';
  }

  el.style.transform = `translateY(${globalIndex * ROW_HEIGHT}px)`;
}

function updateSpacerHeight() {
  scrollSpacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateRowCount() {
  if (state.severity || state.query) {
    rowCountEl.textContent = `${state.total.toLocaleString()} filtered results`;
  } else {
    rowCountEl.textContent = `${state.total.toLocaleString()} total logs`;
  }
}

// Track what we last rendered to avoid redundant DOM operations
let lastRenderStart = -1;
let lastRenderEnd = -1;
let renderScheduled = false;

function renderVisibleRows() {
  const scrollTop = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;

  if (viewportHeight === 0) return; // Not visible yet

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);

  const renderStart = Math.max(0, firstVisible - OVERSCAN);
  const renderEnd = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);
  const renderCount = renderEnd - renderStart;

  // Ensure pool has exactly the right number of elements
  while (poolElements.length < renderCount) {
    const el = createRowElement();
    rowPool.appendChild(el);
    poolElements.push(el);
  }
  // Hide excess
  for (let i = renderCount; i < poolElements.length; i++) {
    poolElements[i].style.display = 'none';
  }

  // Determine which pages we need
  const pagesNeeded = new Set();

  // Update each visible row
  for (let i = 0; i < renderCount; i++) {
    const globalIdx = renderStart + i;
    const el = poolElements[i];
    el.style.display = 'flex';

    const data = getCachedRow(globalIdx);
    updateRowElement(el, data, globalIdx);

    if (!data) {
      const pageIdx = Math.floor(globalIdx / PAGE_SIZE);
      pagesNeeded.add(pageIdx);
    }
  }

  // Trigger fetch for any uncached pages
  for (const pageIdx of pagesNeeded) {
    ensurePageLoaded(pageIdx);
  }

  lastRenderStart = renderStart;
  lastRenderEnd = renderEnd;
}

// ===== Scroll Handler =====

let scrollRAF = null;

function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderVisibleRows();
  });
}

// ===== Filter Handlers =====

let searchDebounceTimer = null;

function applyFilters() {
  const severity = severitySelect.value;
  const query = searchInput.value.trim();

  state.severity = severity;
  state.query = query;
  state.filterEpoch++;
  const epoch = state.filterEpoch;
  clearCache();

  // Reset scroll
  scrollContainer.scrollTop = 0;
  state.total = 0;
  updateSpacerHeight();
  updateRowCount();

  // Clear visible rows immediately
  for (let i = 0; i < poolElements.length; i++) {
    poolElements[i].style.display = 'none';
  }

  // Fetch first page for immediate display
  showLoading();
  apiFetchLogs(0, PAGE_SIZE, severity, query)
    .then((data) => {
      // Only apply if epoch still matches (no newer filter change happened)
      if (state.filterEpoch !== epoch) return;

      state.total = data.total;
      pageCache.set(0, { rows: data.rows, epoch });

      updateSpacerHeight();
      updateRowCount();
      renderVisibleRows();
    })
    .catch((err) => {
      console.error('Filter fetch error:', err);
    })
    .finally(() => {
      hideLoading();
    });
}

function onSeverityChange() {
  // Cancel any pending debounce
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  applyFilters();
}

function onSearchInput() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    applyFilters();
  }, DEBOUNCE_MS);
}

// ===== Initialization =====

async function init() {
  // Load stats for badges
  try {
    const stats = await apiFetchStats();
    if (stats) {
      badgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
        .map(
          (s) =>
            `<span class="badge badge-${s}">${s}: ${(stats.severityCounts[s] || 0).toLocaleString()}</span>`
        )
        .join('');
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }

  // Initial data load
  showLoading();
  try {
    const data = await apiFetchLogs(0, PAGE_SIZE, '', '');

    state.total = data.total;
    pageCache.set(0, { rows: data.rows, epoch: state.filterEpoch });

    updateSpacerHeight();
    updateRowCount();
    renderVisibleRows();
  } catch (err) {
    console.error('Initial load error:', err);
    rowCountEl.textContent = 'Error loading logs';
  } finally {
    hideLoading();
  }

  // Event listeners
  scrollContainer.addEventListener('scroll', onScroll, { passive: true });
  severitySelect.addEventListener('change', onSeverityChange);
  searchInput.addEventListener('input', onSearchInput);
}

init();
