const API_BASE = '/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 36; // approximate row height
let visibleRows = 20; // approx visible
let overscan = 5;
let isLoading = false;
let lastRequestId = 0;

const table = document.getElementById('virtual-table');
const scrollContainer = document.getElementById('scroll-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsEl = document.getElementById('stats');
const rowCountEl = document.getElementById('row-count');

let rowsData = []; // current window of rows
let currentOffset = 0;
let debounceTimer = null;

// Fetch stats
async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    statsEl.innerHTML = `Total: ${data.total} | Debug: ${data.debug} | Info: ${data.info} | Warn: ${data.warn} | Error: ${data.error}`;
  } catch (e) {
    statsEl.innerHTML = 'Stats unavailable';
  }
}

// Fetch logs with window
async function fetchLogs(offset, limit, filters) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
    ...(filters.severity && { severity: filters.severity }),
    ...(filters.q && { q: filters.q })
  });
  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch');
  }
  return res.json();
}

// Render rows in the virtual container
function renderRows(rows, startOffset, totalHeight) {
  scrollContainer.innerHTML = '';
  scrollContainer.style.height = `${totalHeight}px`;

  rows.forEach((row, index) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'table-row';
    const top = (startOffset + index) * rowHeight;
    rowEl.style.top = `${top}px`;
    rowEl.style.height = `${rowHeight}px`;

    const ts = new Date(row.ts).toISOString();
    const sevClass = `severity-${row.severity}`;

    rowEl.innerHTML = `
      <div class="timestamp" style="width:180px">${ts}</div>
      <div class="severity ${sevClass}" style="width:80px">${row.severity.toUpperCase()}</div>
      <div class="service" style="width:120px">${row.service}</div>
      <div class="message" style="flex:1" title="${row.message}">${row.message}</div>
    `;
    scrollContainer.appendChild(rowEl);
  });
}

// Update visible window based on scroll
async function updateVisibleWindow() {
  if (isLoading) return;

  const scrollTop = table.scrollTop;
  const viewportHeight = table.clientHeight;
  const startRow = Math.floor(scrollTop / rowHeight);
  const endRow = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  const startOffset = Math.max(0, startRow - overscan);
  const limit = Math.min(200, endRow - startOffset + overscan);

  if (limit <= 0 || startOffset >= currentTotal) return;

  const requestId = ++lastRequestId;
  isLoading = true;

  try {
    const data = await fetchLogs(startOffset, limit, currentFilters);
    if (requestId !== lastRequestId) return; // stale response

    currentTotal = data.total;
    rowsData = data.rows;
    currentOffset = startOffset;

    const totalHeight = currentTotal * rowHeight;
    renderRows(data.rows, startOffset, totalHeight);
    rowCountEl.textContent = `${data.rows.length} of ${currentTotal} rows (offset ${startOffset})`;
  } catch (e) {
    console.error(e);
    rowCountEl.textContent = 'Error loading rows';
  } finally {
    isLoading = false;
  }
}

// Debounced filter change
function applyFilters() {
  currentFilters.severity = severityFilter.value;
  currentFilters.q = searchInput.value.trim();

  // Reset scroll to top
  table.scrollTop = 0;
  currentOffset = 0;
  rowsData = [];

  // Fetch initial window and update
  updateVisibleWindow();
  fetchStats(); // update stats? but stats are global
}

// Event listeners
severityFilter.addEventListener('change', () => {
  applyFilters();
});

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    applyFilters();
  }, 300);
});

// Scroll listener with throttling
let scrollTimeout;
table.addEventListener('scroll', () => {
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    updateVisibleWindow();
  }, 50);
});

// Initial load
async function init() {
  await fetchStats();
  // Initial fetch for top
  currentFilters = { severity: '', q: '' };
  const initialData = await fetchLogs(0, 50, currentFilters);
  currentTotal = initialData.total;
  const totalHeight = currentTotal * rowHeight;
  scrollContainer.style.height = `${totalHeight}px`;
  renderRows(initialData.rows, 0, totalHeight);
  rowCountEl.textContent = `${initialData.rows.length} of ${currentTotal} rows`;

  // Set initial scroll height properly
  table.scrollTop = 0;
}

init().catch(console.error);

// Handle window resize
window.addEventListener('resize', () => {
  updateVisibleWindow();
});