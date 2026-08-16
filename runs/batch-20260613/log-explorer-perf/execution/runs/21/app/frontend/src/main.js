const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_PAGE_SIZE = 100;
const DEBOUNCE_MS = 250;
const API_BASE = '/api';

// State
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let fetchVersion = 0; // monotonically increasing, to discard stale responses
let cache = new Map(); // cacheKey -> {rows, total}
let renderedOffset = -1;
let renderedCount = 0;

// DOM elements
const scroller = document.getElementById('virtual-scroller');
const scrollContent = document.getElementById('scroll-content');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// Row element pool
const rowPool = [];
const MAX_POOL_SIZE = 150;

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"></div>
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

function recycleRowElement(el) {
  if (rowPool.length < MAX_POOL_SIZE) {
    el.remove();
    rowPool.push(el);
  } else {
    el.remove();
  }
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function renderRow(el, data) {
  const cols = el.children;
  cols[0].textContent = formatTimestamp(data.ts);
  cols[1].textContent = data.severity;
  cols[1].className = `col col-severity severity-${data.severity}`;
  cols[2].textContent = data.service;
  cols[3].textContent = data.message;
}

// Abort controller for filter changes (not scroll fetches)
let filterAbortController = null;

function makeCacheKey(offset, limit, severity, q) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);
  return params.toString();
}

async function fetchLogs(offset, limit, severity, q, version, signal) {
  const cacheKey = makeCacheKey(offset, limit, severity, q);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  try {
    const resp = await fetch(`${API_BASE}/logs?${params.toString()}`, {
      signal: signal
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Only cache if not stale
    if (version === fetchVersion) {
      // Keep cache bounded
      if (cache.size > 200) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
      cache.set(cacheKey, data);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function updateRowCount(showing, total) {
  rowCountEl.textContent = `Showing ${showing} of ${total.toLocaleString()} logs`;
}

function updateScrollHeight() {
  const totalHeight = totalRows * ROW_HEIGHT;
  scrollContent.style.height = `${totalHeight}px`;
}

// Clear and re-render visible rows
function clearRenderedRows() {
  while (rowsContainer.firstChild) {
    recycleRowElement(rowsContainer.firstChild);
  }
  renderedOffset = -1;
  renderedCount = 0;
}

// Scroll-triggered abort controller
let scrollAbortController = null;

async function renderVisibleRows() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  if (totalRows === 0) {
    clearRenderedRows();
    updateRowCount(0, 0);
    return;
  }

  // Calculate which rows should be visible
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);

  // With overscan
  const startRow = Math.max(0, firstVisible - OVERSCAN);
  const endRow = Math.min(totalRows, firstVisible + visibleCount + OVERSCAN);
  const count = endRow - startRow;

  // Check if we need to fetch new data
  if (startRow === renderedOffset && count === renderedCount) {
    return; // Nothing changed
  }

  const version = fetchVersion;

  // Abort previous scroll-triggered fetches
  if (scrollAbortController) {
    scrollAbortController.abort();
  }
  scrollAbortController = new AbortController();
  const signal = scrollAbortController.signal;

  // Determine the fetch window - align to page boundaries for better caching
  const fetchStart = Math.floor(startRow / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
  const fetchEnd = Math.min(totalRows, Math.ceil(endRow / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE);

  // We might need multiple pages
  const pagePromises = [];
  for (let offset = fetchStart; offset < fetchEnd; offset += FETCH_PAGE_SIZE) {
    const limit = Math.min(FETCH_PAGE_SIZE, fetchEnd - offset);
    pagePromises.push(fetchLogs(offset, limit, currentSeverity, currentQuery, version, signal));
  }

  try {
    const results = await Promise.all(pagePromises);

    // Check if still current
    if (version !== fetchVersion) return;

    // Check for aborted
    if (results.some(r => r === null)) return;

    // Merge rows and update total
    let allRows = [];
    for (const result of results) {
      totalRows = result.total;
      allRows = allRows.concat(result.rows);
    }

    // Extract the rows we need from the merged results
    const localStart = startRow - fetchStart;
    const neededRows = allRows.slice(localStart, localStart + count);

    // Update DOM
    clearRenderedRows();

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < neededRows.length; i++) {
      const el = getRowElement();
      renderRow(el, neededRows[i]);
      fragment.appendChild(el);
    }

    rowsContainer.style.top = `${startRow * ROW_HEIGHT}px`;
    rowsContainer.appendChild(fragment);

    renderedOffset = startRow;
    renderedCount = count;

    updateScrollHeight();
    updateRowCount(Math.min(visibleCount, totalRows), totalRows);

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Error fetching logs:', err);
    }
  }
}

// Debounce utility
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Throttle for scroll - ensures we don't fetch too rapidly
let renderPending = false;
let renderScheduled = false;

function scheduleRender() {
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!renderPending) {
        renderPending = true;
        renderVisibleRows().finally(() => {
          renderPending = false;
        });
      }
    });
  }
}

async function onFilterChange() {
  fetchVersion++;
  cache.clear();
  clearRenderedRows();
  scroller.scrollTop = 0;

  // Abort any in-flight filter requests
  if (filterAbortController) {
    filterAbortController.abort();
  }
  filterAbortController = new AbortController();

  // Get initial total
  try {
    const data = await fetchLogs(0, FETCH_PAGE_SIZE, currentSeverity, currentQuery, fetchVersion, filterAbortController.signal);
    if (data === null) return; // aborted
    totalRows = data.total;
    updateScrollHeight();
    renderVisibleRows();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Error on filter change:', err);
    }
  }
}

// Event listeners
severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  onFilterChange();
});

const debouncedSearch = debounce(() => {
  currentQuery = searchInput.value.trim();
  onFilterChange();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

scroller.addEventListener('scroll', scheduleRender, { passive: true });

// Handle resize
window.addEventListener('resize', scheduleRender);

// Initial load
async function init() {
  try {
    // Load stats for badges
    const stats = await fetchStats();

    badgesEl.innerHTML = ['debug', 'info', 'warn', 'error'].map(sev => {
      const count = stats.bySeverity[sev] || 0;
      return `<span class="badge badge-${sev}">${sev}: ${count.toLocaleString()}</span>`;
    }).join('');

    totalRows = stats.total;
    updateScrollHeight();

    // Fetch first page
    await renderVisibleRows();
  } catch (err) {
    console.error('Failed to initialize:', err);
    rowCountEl.textContent = 'Error loading logs. Is the server running?';
  }
}

init();
