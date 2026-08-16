const API_BASE = 'http://localhost:3001';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const VISIBLE_ROWS = 20; // approx for 600px height

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let currentOffset = 0;
let isLoading = false;
let abortController = null;
let debounceTimer = null;
let lastRequestTime = 0;

const severityEl = document.getElementById('severity-filter');
const searchEl = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const logBody = document.getElementById('log-body');
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const statusEl = document.getElementById('status');

let renderedRows = new Map(); // offset -> row data for recycling

function updateRowCount() {
  rowCountEl.textContent = `${currentTotal.toLocaleString()} rows`;
}

function getSeverityClass(sev) {
  return `severity-${sev}`;
}

function formatTimestamp(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function renderRows(rows, startOffset) {
  logBody.innerHTML = '';
  renderedRows.clear();

  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const offset = startOffset + index;
    tr.dataset.offset = offset;
    tr.innerHTML = `
      <td>${formatTimestamp(row.ts)}</td>
      <td class="${getSeverityClass(row.severity)}">${row.severity.toUpperCase()}</td>
      <td>${row.service}</td>
      <td class="message">${row.message}</td>
    `;
    logBody.appendChild(tr);
    renderedRows.set(offset, row);
  });
}

async function fetchWindow(offset, limit, filters, signal) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);

  const res = await fetch(`${API_BASE}/api/logs?${params}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

async function loadData(offset, filters, force = false) {
  if (isLoading && !force) return;
  isLoading = true;
  statusEl.textContent = 'Loading...';

  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  const requestTime = Date.now();
  lastRequestTime = requestTime;

  try {
    // Fetch a window around the offset
    const windowSize = VISIBLE_ROWS + OVERSCAN * 2;
    const fetchOffset = Math.max(0, offset - OVERSCAN);

    const data = await fetchWindow(fetchOffset, windowSize, filters, abortController.signal);

    if (requestTime !== lastRequestTime) {
      // stale response
      return;
    }

    currentTotal = data.total;
    currentOffset = offset;
    updateRowCount();

    // Set spacer height
    const totalHeight = currentTotal * ROW_HEIGHT;
    spacer.style.height = `${totalHeight}px`;
    spacer.style.top = '40px'; // header height approx

    renderRows(data.rows, fetchOffset);

    // Adjust scroll position if needed (for initial or filter change)
    const targetScroll = offset * ROW_HEIGHT;
    if (Math.abs(scroller.scrollTop - targetScroll) > ROW_HEIGHT * 2) {
      scroller.scrollTop = targetScroll;
    }

    statusEl.textContent = `Showing rows ${fetchOffset + 1}-${fetchOffset + data.rows.length} of ${currentTotal.toLocaleString()}`;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      statusEl.textContent = `Error: ${err.message}`;
    }
  } finally {
    isLoading = false;
  }
}

function onScroll() {
  const scrollTop = scroller.scrollTop;
  const newOffset = Math.floor(scrollTop / ROW_HEIGHT);

  if (Math.abs(newOffset - currentOffset) > 5 || newOffset < currentOffset - OVERSCAN || newOffset > currentOffset + VISIBLE_ROWS) {
    loadData(newOffset, currentFilter);
  }
}

function applyFilters() {
  currentFilter = {
    severity: severityEl.value,
    q: searchEl.value.trim()
  };
  currentOffset = 0;
  scroller.scrollTop = 0;
  loadData(0, currentFilter, true);
}

function setupEventListeners() {
  severityEl.addEventListener('change', applyFilters);

  searchEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyFilters();
    }, 300);
  });

  scroller.addEventListener('scroll', () => {
    // Throttle scroll handling
    if (!window.scrollThrottle) {
      window.scrollThrottle = setTimeout(() => {
        onScroll();
        window.scrollThrottle = null;
      }, 50);
    }
  });

  // Initial load
  window.addEventListener('load', () => {
    loadData(0, currentFilter, true);
  });

  // Keyboard support
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchEl.value = '';
      severityEl.value = '';
      applyFilters();
    }
  });
}

function init() {
  setupEventListeners();
  // Set initial spacer
  spacer.style.height = '3200000px'; // 100k * 32
  spacer.style.top = '40px';
  statusEl.textContent = 'Ready. Scroll or filter to explore 100k logs.';
}

init();