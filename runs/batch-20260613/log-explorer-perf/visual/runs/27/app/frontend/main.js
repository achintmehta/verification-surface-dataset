const API_BASE = ''; // proxied

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32; // approx
let visibleRows = 20;
let overscan = 5;
let isFetching = false;
let lastRequestId = 0;

const tbody = document.getElementById('log-tbody');
const scroller = document.getElementById('virtual-scroller');
const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let rowsData = []; // current window rows
let windowOffset = 0; // offset of first row in current data

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function fetchLogs(offset, limit, filters) {
  const params = new URLSearchParams({ offset, limit, ...filters });
  const res = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!res.ok) throw new Error('Fetch failed');
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  return res.json();
}

function updateRowCount() {
  rowCountEl.textContent = `${rowsData.length} of ${currentTotal.toLocaleString()}`;
}

function renderRows() {
  tbody.innerHTML = '';
  if (!rowsData.length) return;

  const fragment = document.createDocumentFragment();
  rowsData.forEach(row => {
    const tr = document.createElement('tr');
    const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
    tr.innerHTML = `
      <td>${ts}</td>
      <td class="severity-${row.severity}">${row.severity.toUpperCase()}</td>
      <td>${row.service}</td>
      <td title="${row.message}">${row.message}</td>
    `;
    fragment.appendChild(tr);
  });
  tbody.appendChild(fragment);
  updateRowCount();
}

function setScrollHeight() {
  // Use a spacer to simulate full height
  let spacer = scroller.querySelector('.spacer');
  if (!spacer) {
    spacer = document.createElement('div');
    spacer.className = 'spacer';
    spacer.style.position = 'absolute';
    spacer.style.top = '0';
    spacer.style.left = '0';
    spacer.style.width = '1px';
    spacer.style.pointerEvents = 'none';
    scroller.appendChild(spacer);
  }
  const totalHeight = Math.max(1, currentTotal) * rowHeight;
  spacer.style.height = `${totalHeight}px`;
}

function getVisibleRange() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIdx = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { startIdx, endIdx };
}

async function loadWindow(startOffset) {
  if (isFetching) return;
  isFetching = true;
  const requestId = ++lastRequestId;
  const limit = 100; // fetch a bit more than visible

  try {
    const data = await fetchLogs(startOffset, limit, currentFilter);
    if (requestId !== lastRequestId) return; // stale

    rowsData = data.rows;
    windowOffset = startOffset;
    currentTotal = data.total;

    setScrollHeight();
    renderRows();

    // Position tbody to correct top
    const topOffset = windowOffset * rowHeight;
    tbody.style.position = 'absolute';
    tbody.style.top = `${topOffset}px`;
    tbody.style.width = '100%';
  } catch (e) {
    console.error(e);
  } finally {
    isFetching = false;
  }
}

function onScroll() {
  const { startIdx } = getVisibleRange();
  // If out of current window, reload
  if (startIdx < windowOffset || startIdx >= windowOffset + rowsData.length - 5) {
    loadWindow(Math.max(0, startIdx - 10));
  }
}

function resetAndLoad() {
  rowsData = [];
  windowOffset = 0;
  tbody.innerHTML = '';
  currentTotal = 0;
  setScrollHeight();
  loadWindow(0);
}

function initFilters() {
  severitySelect.addEventListener('change', () => {
    currentFilter.severity = severitySelect.value;
    resetAndLoad();
  });

  const debouncedSearch = debounce(() => {
    currentFilter.q = searchInput.value.trim();
    resetAndLoad();
  }, 250);

  searchInput.addEventListener('input', debouncedSearch);
}

function initVirtualScroller() {
  scroller.addEventListener('scroll', () => {
    // throttle a bit
    if (!window._scrollTimer) {
      window._scrollTimer = setTimeout(() => {
        onScroll();
        window._scrollTimer = null;
      }, 16);
    }
  });

  // Initial load
  setTimeout(() => {
    setScrollHeight();
    loadWindow(0);
  }, 100);
}

async function init() {
  initFilters();
  initVirtualScroller();

  // Optional: load stats initially but row count is dynamic
  // Keyboard hint etc not needed
  console.log('Log Explorer initialized');
}

init();