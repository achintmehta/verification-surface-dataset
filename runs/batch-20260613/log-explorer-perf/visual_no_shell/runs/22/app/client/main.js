/**
 * Log Explorer — Virtualized Frontend
 *
 * The virtual scroller maintains a window of DOM rows that map to a slice
 * of the (filtered, sorted) corpus. Data is fetched window-by-window from
 * the API; the DOM never holds more than ~100 rows regardless of corpus size.
 */

const API_BASE = '/api';
const ROW_HEIGHT = 36;      // must match CSS --row-height
const OVERSCAN = 10;        // extra rows above/below viewport
const FETCH_PAGE_SIZE = 100; // rows per API call
const DEBOUNCE_MS = 250;

// ─── State ───────────────────────────────────────────────────────────

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let fetchGeneration = 0;    // monotonic counter to discard stale responses

// Cache of fetched pages: Map<pageKey, { rows, generation }>
// pageKey = `${severity}|${query}|${pageOffset}`
const pageCache = new Map();
const MAX_CACHE_PAGES = 50;

// ─── DOM refs ────────────────────────────────────────────────────────

const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowContainer = document.getElementById('row-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// ─── Row pool ────────────────────────────────────────────────────────

/**
 * We keep a pool of DOM row elements and recycle them as the user scrolls.
 * Each row element has data attributes and inner spans that get updated.
 */
const rowPool = [];
const MAX_POOL_SIZE = 100;

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"><span class="badge"></span></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return row;
}

function getRowElement() {
  if (rowPool.length > 0) {
    return rowPool.pop();
  }
  return createRowElement();
}

function releaseRowElement(el) {
  if (rowPool.length < MAX_POOL_SIZE) {
    el.style.display = 'none';
    rowPool.push(el);
  } else {
    el.remove();
  }
}

// ─── Rendering ───────────────────────────────────────────────────────

// Currently rendered row elements by their absolute index
const renderedRows = new Map(); // offset -> element

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function updateRowElement(el, row, offset) {
  el.style.display = '';
  el.style.top = `${offset * ROW_HEIGHT}px`;

  const cols = el.children;
  cols[0].textContent = formatTimestamp(row.ts);

  const badge = cols[1].firstElementChild;
  badge.textContent = row.severity;
  badge.className = `badge ${row.severity}`;

  cols[2].textContent = row.service;
  cols[3].textContent = row.message;
}

function render() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const rangeStart = Math.max(0, firstVisible - OVERSCAN);
  const rangeEnd = Math.min(totalRows, lastVisible + OVERSCAN);

  // Determine which pages we need
  const neededPages = new Set();
  for (let i = rangeStart; i < rangeEnd; i++) {
    const pageOffset = Math.floor(i / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
    neededPages.add(pageOffset);
  }

  // Request missing pages
  for (const pageOffset of neededPages) {
    fetchPage(pageOffset);
  }

  // Remove rows outside range
  for (const [offset, el] of renderedRows) {
    if (offset < rangeStart || offset >= rangeEnd) {
      renderedRows.delete(offset);
      if (el.parentNode) el.parentNode.removeChild(el);
      releaseRowElement(el);
    }
  }

  // Add/update rows in range
  for (let i = rangeStart; i < rangeEnd; i++) {
    const rowData = getRowData(i);
    if (!rowData) continue; // not yet fetched

    if (renderedRows.has(i)) {
      // Already rendered; update position in case it shifted
      const el = renderedRows.get(i);
      updateRowElement(el, rowData, i);
    } else {
      const el = getRowElement();
      updateRowElement(el, rowData, i);
      rowContainer.appendChild(el);
      renderedRows.set(i, el);
    }
  }

  updateRowCount();
}

function getRowData(absoluteIndex) {
  const pageOffset = Math.floor(absoluteIndex / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
  const cacheKey = makeCacheKey(pageOffset);
  const page = pageCache.get(cacheKey);
  if (!page) return null;
  const localIndex = absoluteIndex - pageOffset;
  return page.rows[localIndex] || null;
}

function makeCacheKey(pageOffset) {
  return `${currentSeverity}|${currentQuery}|${pageOffset}`;
}

// ─── Data fetching ───────────────────────────────────────────────────

const inFlightPages = new Set();

async function fetchPage(pageOffset) {
  const cacheKey = makeCacheKey(pageOffset);
  if (pageCache.has(cacheKey) || inFlightPages.has(cacheKey)) return;

  inFlightPages.add(cacheKey);
  const gen = fetchGeneration;

  try {
    const params = new URLSearchParams({
      offset: String(pageOffset),
      limit: String(FETCH_PAGE_SIZE),
    });
    if (currentSeverity) params.set('severity', currentSeverity);
    if (currentQuery) params.set('q', currentQuery);

    const resp = await fetch(`${API_BASE}/logs?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Discard if generation has moved on (filter changed)
    if (gen !== fetchGeneration) return;

    // Evict old cache entries if too many
    if (pageCache.size >= MAX_CACHE_PAGES) {
      // Remove oldest entries (first inserted)
      const keysIter = pageCache.keys();
      let toRemove = pageCache.size - MAX_CACHE_PAGES + 1;
      while (toRemove-- > 0) {
        const oldKey = keysIter.next().value;
        pageCache.delete(oldKey);
      }
    }

    pageCache.set(cacheKey, { rows: data.rows, generation: gen });

    // Re-render to fill in any blank rows
    render();
  } catch (err) {
    console.error('[fetch] Error fetching page:', err);
  } finally {
    inFlightPages.delete(cacheKey);
  }
}

async function fetchTotalAndReset() {
  const gen = ++fetchGeneration;

  // Clear caches and rendered rows
  pageCache.clear();
  inFlightPages.clear();
  clearRenderedRows();

  // Fetch the first page to get both total and initial data
  const params = new URLSearchParams({ offset: '0', limit: String(FETCH_PAGE_SIZE) });
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  try {
    const resp = await fetch(`${API_BASE}/logs?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Stale check
    if (gen !== fetchGeneration) return;

    totalRows = data.total;

    // Cache the first page
    const cacheKey = `${currentSeverity}|${currentQuery}|0`;
    pageCache.set(cacheKey, { rows: data.rows, generation: gen });

    updateScrollHeight();
    scroller.scrollTop = 0;
    render();
    updateRowCount();
  } catch (err) {
    console.error('[fetch] Error fetching total:', err);
  }
}

function clearRenderedRows() {
  for (const [offset, el] of renderedRows) {
    if (el.parentNode) el.parentNode.removeChild(el);
    releaseRowElement(el);
  }
  renderedRows.clear();
}

function updateScrollHeight() {
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateRowCount() {
  rowCountEl.textContent = `${renderedRows.size} of ${totalRows.toLocaleString()} entries`;
}

// ─── Stats / badges ──────────────────────────────────────────────────

async function fetchStats() {
  try {
    const resp = await fetch(`${API_BASE}/stats`);
    if (!resp.ok) return;
    const data = await resp.json();

    badgesEl.innerHTML = '';
    for (const sev of ['debug', 'info', 'warn', 'error']) {
      const count = data.severities[sev] || 0;
      const badge = document.createElement('span');
      badge.className = `severity-badge ${sev}`;
      badge.textContent = `${sev}: ${count.toLocaleString()}`;
      badgesEl.appendChild(badge);
    }
  } catch (err) {
    console.error('[stats] Error:', err);
  }
}

// ─── Event handlers ──────────────────────────────────────────────────

let scrollRafId = null;

scroller.addEventListener('scroll', () => {
  if (scrollRafId) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    render();
  });
}, { passive: true });

severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  fetchTotalAndReset();
});

let searchTimeout = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentQuery = searchInput.value.trim();
    fetchTotalAndReset();
  }, DEBOUNCE_MS);
});

// ─── Init ────────────────────────────────────────────────────────────

async function init() {
  await fetchStats();
  await fetchTotalAndReset();
}

init();
