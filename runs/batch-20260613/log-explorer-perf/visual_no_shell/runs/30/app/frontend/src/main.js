const API_BASE = 'http://localhost:3001/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let overscan = 10;
let visibleRows = 20; // approx

let debounceTimer = null;
let currentRequestId = 0;
let isLoading = false;

const scroller = document.getElementById('scroller');
const content = document.getElementById('virtual-content');
const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

// Set initial scroller height placeholder
function updateScrollerHeight(total) {
  const height = total * rowHeight;
  content.style.height = `${height}px`;
}

function updateRowCount(filteredTotal) {
  rowCountEl.textContent = `${filteredTotal.toLocaleString()} of ${currentTotal.toLocaleString()}`;
}

function createRowElement(row, top) {
  const rowEl = document.createElement('div');
  rowEl.className = 'log-row';
  rowEl.style.position = 'absolute';
  rowEl.style.top = `${top}px`;
  rowEl.style.width = '100%';
  rowEl.style.height = `${rowHeight}px`;
  
  const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
  
  rowEl.innerHTML = `
    <div class="col-ts">${ts}</div>
    <div class="col-severity">
      <span class="severity severity-${row.severity}">${row.severity}</span>
    </div>
    <div class="col-service">${row.service}</div>
    <div class="col-message" title="${row.message}">${row.message}</div>
  `;
  
  return rowEl;
}

let renderedRows = new Map(); // offset -> element

async function fetchLogs(offset, limit, filter) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (filter.severity) params.set('severity', filter.severity);
  if (filter.q) params.set('q', filter.q);
  
  const requestId = ++currentRequestId;
  
  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Request failed');
  }
  
  const data = await res.json();
  
  // Ignore stale responses
  if (requestId !== currentRequestId) {
    return null;
  }
  
  return data;
}

async function loadWindow(startOffset, count) {
  if (isLoading) return;
  isLoading = true;
  
  try {
    const data = await fetchLogs(startOffset, count, currentFilter);
    if (!data) return; // stale
    
    currentTotal = data.total; // update if changed? but for filtered it's the filtered total
    updateScrollerHeight(data.total);
    updateRowCount(data.total);
    
    // Clear existing rows
    content.innerHTML = '';
    renderedRows.clear();
    
    // Render the window
    data.rows.forEach((row, i) => {
      const offset = startOffset + i;
      const top = offset * rowHeight;
      const rowEl = createRowElement(row, top);
      content.appendChild(rowEl);
      renderedRows.set(offset, rowEl);
    });
  } catch (e) {
    console.error('Failed to load logs:', e);
    content.innerHTML = `<div class="loading">Error loading logs: ${e.message}</div>`;
  } finally {
    isLoading = false;
  }
}

function getVisibleRange() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  
  const startRow = Math.floor(scrollTop / rowHeight);
  const endRow = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  
  return {
    start: Math.max(0, startRow - overscan),
    end: endRow + overscan
  };
}

let lastRenderedStart = -1;
let lastRenderedEnd = -1;

async function renderVisibleWindow() {
  const range = getVisibleRange();
  const neededStart = range.start;
  const neededEnd = Math.min(range.end, currentTotal);
  
  // If we have a big gap or first time, fetch new window
  if (lastRenderedStart === -1 || 
      neededStart < lastRenderedStart || 
      neededEnd > lastRenderedEnd ||
      neededEnd - neededStart > 50) {
    
    const windowSize = Math.min(100, neededEnd - neededStart + 20);
    const fetchStart = Math.max(0, neededStart);
    
    await loadWindow(fetchStart, windowSize);
    lastRenderedStart = fetchStart;
    lastRenderedEnd = fetchStart + windowSize;
  } else {
    // Recycle: just adjust positions if needed, but since we refetch small, simple approach
  }
}

function debounceSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentFilter.q = searchInput.value.trim();
    resetAndLoad();
  }, 300);
}

function resetAndLoad() {
  lastRenderedStart = -1;
  lastRenderedEnd = -1;
  content.innerHTML = '';
  renderedRows.clear();
  scroller.scrollTop = 0;
  loadInitial();
}

async function loadInitial() {
  // First get stats for total
  try {
    const statsRes = await fetch(`${API_BASE}/stats`);
    const stats = await statsRes.json();
    currentTotal = stats.total;
  } catch (e) {
    currentTotal = 100000; // fallback
  }
  
  updateScrollerHeight(currentTotal);
  updateRowCount(currentTotal);
  
  // Load first window
  await loadWindow(0, 50);
  lastRenderedStart = 0;
  lastRenderedEnd = 50;
}

// Event listeners
severitySelect.addEventListener('change', () => {
  currentFilter.severity = severitySelect.value;
  resetAndLoad();
});

searchInput.addEventListener('input', debounceSearch);

scroller.addEventListener('scroll', () => {
  // Throttle render
  if (!window.scrollRaf) {
    window.scrollRaf = requestAnimationFrame(() => {
      renderVisibleWindow();
      window.scrollRaf = null;
    });
  }
});

// Handle window resize
window.addEventListener('resize', () => {
  renderVisibleWindow();
});

// Boot
async function init() {
  // Set initial content height
  content.style.height = '3200000px'; // 100k * 32
  
  await loadInitial();
  
  // Prefetch stats for badges if needed, but row count is dynamic
  console.log('Log explorer initialized');
}

init();