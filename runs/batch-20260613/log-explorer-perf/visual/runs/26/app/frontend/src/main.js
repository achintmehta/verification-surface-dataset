const API_BASE = 'http://localhost:3001/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 37; // approx row height
let visibleRows = 20; // will calculate
let overscan = 5;
let isLoading = false;
let currentRequestId = 0;
let abortController = null;

const viewport = document.getElementById('log-viewport');
const scroller = document.getElementById('log-scroller');
const tbody = document.getElementById('log-tbody');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let renderedRows = new Map(); // offset -> row element

function updateRowCount() {
  rowCountEl.textContent = `${renderedRows.size} of ${currentTotal.toLocaleString()}`;
}

function getVisibleRange() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  const startOffset = Math.floor(scrollTop / rowHeight);
  const endOffset = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  return {
    start: Math.max(0, startOffset - overscan),
    end: endOffset + overscan
  };
}

async function fetchLogs(offset, limit, filters, requestId) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filters.severity) params.append('severity', filters.severity);
  if (filters.q) params.append('q', filters.q);

  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  const res = await fetch(`${API_BASE}/logs?${params}`, {
    signal: abortController.signal
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch');
  }
  const data = await res.json();
  if (requestId !== currentRequestId) {
    return null; // stale
  }
  return data;
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    return await res.json();
  } catch (e) {
    return { total: 0, perSeverity: {} };
  }
}

function createRowElement(log, absoluteTop) {
  const tr = document.createElement('tr');
  tr.className = `log-row severity-${log.severity}`;
  tr.style.top = `${absoluteTop}px`;
  tr.style.height = `${rowHeight}px`;
  tr.innerHTML = `
    <td>${new Date(log.ts).toLocaleString()}</td>
    <td class="severity-${log.severity}">${log.severity.toUpperCase()}</td>
    <td>${log.service}</td>
    <td title="${log.message}">${log.message}</td>
  `;
  return tr;
}

function renderWindow(rows, startOffset) {
  // Clear previous
  tbody.innerHTML = '';
  renderedRows.clear();

  const fragment = document.createDocumentFragment();

  rows.forEach((log, i) => {
    const offset = startOffset + i;
    const absoluteTop = offset * rowHeight;
    const rowEl = createRowElement(log, absoluteTop);
    fragment.appendChild(rowEl);
    renderedRows.set(offset, rowEl);
  });

  tbody.appendChild(fragment);

  // Set scroller height
  scroller.style.height = `${currentTotal * rowHeight}px`;
  updateRowCount();
}

async function loadWindow(startOffset, limit = 50) {
  if (isLoading) return;
  isLoading = true;
  currentRequestId++;
  const requestId = currentRequestId;

  try {
    const data = await fetchLogs(startOffset, limit, currentFilters, requestId);
    if (data && requestId === currentRequestId) {
      currentTotal = data.total;
      renderWindow(data.rows, startOffset);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch error:', err);
    }
  } finally {
    isLoading = false;
  }
}

function onScroll() {
  const range = getVisibleRange();
  const neededStart = range.start;
  // Check if we need to load new window
  const hasRendered = Array.from(renderedRows.keys());
  const minRendered = hasRendered.length ? Math.min(...hasRendered) : -1;
  const maxRendered = hasRendered.length ? Math.max(...hasRendered) : -1;

  const windowSize = 50;
  if (neededStart < minRendered || neededStart + windowSize > maxRendered + 10 || hasRendered.length === 0) {
    // Load new window around visible
    const loadStart = Math.max(0, neededStart - 10);
    loadWindow(loadStart, windowSize + 20);
  }
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function applyFilters() {
  currentFilters.severity = severitySelect.value;
  currentFilters.q = searchInput.value.trim();
  // Reset scroll and load from top
  viewport.scrollTop = 0;
  scroller.style.height = '0px';
  tbody.innerHTML = '';
  renderedRows.clear();
  loadWindow(0, 50);
}

function setupEventListeners() {
  severitySelect.addEventListener('change', applyFilters);

  const debouncedSearch = debounce(() => {
    applyFilters();
  }, 300);

  searchInput.addEventListener('input', debouncedSearch);

  viewport.addEventListener('scroll', () => {
    // Throttle scroll a bit
    if (!window.scrollThrottle) {
      window.scrollThrottle = setTimeout(() => {
        onScroll();
        window.scrollThrottle = null;
      }, 50);
    }
  });

  // Initial load stats optional
  fetchStats().then(stats => {
    // could update badges but for now simple
  });
}

function init() {
  // Calculate visible rows
  const viewportHeight = viewport.clientHeight || 600;
  visibleRows = Math.ceil(viewportHeight / rowHeight) + 2;

  // Set initial scroller height after first load
  setupEventListeners();

  // Initial load
  loadWindow(0, 50);

  // Make sure scroller has proper height after load
  setTimeout(() => {
    if (currentTotal > 0) {
      scroller.style.height = `${currentTotal * rowHeight}px`;
    }
  }, 500);
}

init();