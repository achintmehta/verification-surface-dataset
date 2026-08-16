const API_BASE = '/api';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const PAGE_SIZE = 100;

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let currentOffset = 0;
let isLoading = false;
let lastRequestId = 0;
let abortController = null;

const container = document.getElementById('table-container');
const scroller = document.getElementById('scroller');
const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsEl = document.getElementById('stats-display');

let visibleRows = new Map(); // offset -> element

// Debounce helper
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// Fetch stats
async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    if (!res.ok) return;
    const stats = await res.json();
    const parts = [`Total: ${stats.total.toLocaleString()}`];
    Object.entries(stats.perSeverity).forEach(([sev, cnt]) => {
      if (cnt > 0) parts.push(`${sev}: ${cnt.toLocaleString()}`);
    });
    statsEl.textContent = parts.join(' | ');
  } catch (e) {
    console.error('Stats fetch failed', e);
  }
}

// Fetch logs window
async function fetchLogs(offset, limit, filters) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);
  
  const requestId = ++lastRequestId;
  
  if (abortController) abortController.abort();
  abortController = new AbortController();
  
  try {
    const res = await fetch(`${API_BASE}/logs?${params}`, { signal: abortController.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Request failed');
    }
    const data = await res.json();
    
    // Ignore stale responses
    if (requestId !== lastRequestId) {
      return null;
    }
    
    return data;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

// Render a single row
function createRowElement(row, absoluteTop) {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.style.top = `${absoluteTop}px`;
  el.innerHTML = `
    <div class="col-ts">${new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19)}</div>
    <div class="col-sev sev-${row.severity}">${row.severity}</div>
    <div class="col-svc">${row.service}</div>
    <div class="col-msg" title="${row.message.replace(/"/g, '&quot;')}">${row.message}</div>
  `;
  return el;
}

// Update visible rows for current scroll
async function updateVisibleRows() {
  if (isLoading || currentTotal === 0) return;
  
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;
  
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  
  const neededOffsets = new Set();
  for (let i = startRow; i < endRow; i++) {
    neededOffsets.add(i);
  }
  
  // Remove rows no longer visible
  for (const [offset, el] of visibleRows) {
    if (!neededOffsets.has(offset)) {
      el.remove();
      visibleRows.delete(offset);
    }
  }
  
  // Compute which pages/windows to fetch
  const fetchStart = Math.floor(startRow / PAGE_SIZE) * PAGE_SIZE;
  const fetchEnd = Math.ceil(endRow / PAGE_SIZE) * PAGE_SIZE;
  
  const promises = [];
  for (let off = fetchStart; off < fetchEnd; off += PAGE_SIZE) {
    const pageOffset = off;
    const pageLimit = Math.min(PAGE_SIZE, currentTotal - pageOffset);
    if (pageLimit <= 0) continue;
    
    // Check if we already have some
    let needsFetch = false;
    for (let i = 0; i < pageLimit; i++) {
      if (!visibleRows.has(pageOffset + i)) {
        needsFetch = true;
        break;
      }
    }
    
    if (needsFetch) {
      promises.push(
        fetchLogs(pageOffset, pageLimit, currentFilter).then(data => {
          if (!data) return;
          // Update total if changed (filter)
          if (data.total !== currentTotal) {
            currentTotal = data.total;
            updateScrollerHeight();
            updateRowCount();
          }
          renderRowsFromData(data.rows, pageOffset);
        })
      );
    }
  }
  
  if (promises.length) {
    isLoading = true;
    await Promise.all(promises);
    isLoading = false;
  }
  
  // Ensure all needed are rendered (in case partial)
  for (let offset of neededOffsets) {
    if (!visibleRows.has(offset)) {
      // Will be filled on next scroll or fetch
    }
  }
}

function renderRowsFromData(rows, baseOffset) {
  rows.forEach((row, idx) => {
    const offset = baseOffset + idx;
    if (visibleRows.has(offset)) return;
    
    const absoluteTop = offset * ROW_HEIGHT;
    const el = createRowElement(row, absoluteTop);
    scroller.appendChild(el);
    visibleRows.set(offset, el);
  });
}

function updateScrollerHeight() {
  scroller.style.height = `${currentTotal * ROW_HEIGHT}px`;
}

function updateRowCount() {
  rowCountEl.textContent = `${visibleRows.size} of ${currentTotal.toLocaleString()} rows (filtered)`;
}

// Handle scroll
let scrollTimer;
container.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    updateVisibleRows();
  }, 16); // ~60fps
});

// Filter change handler
function onFiltersChange() {
  currentFilter.severity = severitySelect.value;
  currentFilter.q = searchInput.value.trim();
  
  // Reset
  currentOffset = 0;
  currentTotal = 0;
  visibleRows.forEach(el => el.remove());
  visibleRows.clear();
  scroller.style.height = '0px';
  
  // Fetch initial window and total
  loadInitialData();
}

async function loadInitialData() {
  isLoading = true;
  try {
    const data = await fetchLogs(0, PAGE_SIZE, currentFilter);
    if (!data) return;
    
    currentTotal = data.total;
    updateScrollerHeight();
    updateRowCount();
    
    renderRowsFromData(data.rows, 0);
    
    // Initial visible
    setTimeout(() => updateVisibleRows(), 50);
  } catch (e) {
    console.error(e);
    scroller.innerHTML = `<div class="loading">Error loading logs: ${e.message}</div>`;
  }
  isLoading = false;
}

// Debounced search
const debouncedSearch = debounce(() => {
  onFiltersChange();
}, 300);

searchInput.addEventListener('input', debouncedSearch);
severitySelect.addEventListener('change', onFiltersChange);

// Initial load
async function init() {
  await fetchStats();
  await loadInitialData();
  
  // Poll stats occasionally? but static ok
  // Resize handler
  window.addEventListener('resize', () => {
    updateVisibleRows();
  });
  
  // Keyboard hint
  console.log('%c[LogExplorer] Virtualized table ready. Scroll to test deep offsets.', 'color:#888');
}

init();