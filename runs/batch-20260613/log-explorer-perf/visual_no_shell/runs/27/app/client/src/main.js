const API_BASE = 'http://localhost:3000/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let visibleRows = 20; // approx
let overscan = 5;
let isLoading = false;
let lastRequestId = 0;
let debounceTimer = null;

const scroller = document.getElementById('virtual-scroller');
const container = document.getElementById('table-container');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let rowsData = []; // currently rendered rows
let currentOffset = 0;

function updateRowCount() {
  rowCountEl.textContent = `${rowsData.length} of ${currentTotal.toLocaleString()} rows (filtered)`;
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    statsEl.innerHTML = `Total: ${data.total.toLocaleString()} | Debug: ${data.perSeverity.debug} | Info: ${data.perSeverity.info} | Warn: ${data.perSeverity.warn} | Error: ${data.perSeverity.error}`;
  } catch (e) {
    console.error(e);
  }
}

async function fetchLogs(offset, limit, filters, requestId) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filters.severity) params.append('severity', filters.severity);
  if (filters.q) params.append('q', filters.q);

  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Request failed');
  }
  const data = await res.json();
  return { data, requestId };
}

function renderRows(rows, startOffset) {
  scroller.innerHTML = '';
  scroller.style.height = `${currentTotal * rowHeight}px`;

  rows.forEach((row, idx) => {
    const div = document.createElement('div');
    div.className = `log-row`;
    const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
    div.innerHTML = `
      <div class="col-ts">${ts}</div>
      <div class="col-sev ${row.severity}">${row.severity.toUpperCase()}</div>
      <div class="col-service">${row.service}</div>
      <div class="col-msg" title="${row.message}">${row.message}</div>
    `;
    div.style.position = 'absolute';
    div.style.top = `${(startOffset + idx) * rowHeight}px`;
    div.style.width = '100%';
    scroller.appendChild(div);
  });
}

function updateVisibleRows() {
  if (isLoading || currentTotal === 0) return;

  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endRow = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  const neededCount = endRow - startRow;

  if (neededCount <= 0) return;

  // Check if we need to fetch new window
  const needsFetch = startRow < currentOffset || startRow + neededCount > currentOffset + rowsData.length || rowsData.length === 0;

  if (needsFetch) {
    const fetchOffset = Math.max(0, startRow);
    const limit = Math.min(200, neededCount + 2 * overscan);
    loadWindow(fetchOffset, limit);
  } else {
    // recycle existing
    const relativeStart = startRow - currentOffset;
    const visibleSlice = rowsData.slice(Math.max(0, relativeStart), Math.max(0, relativeStart) + neededCount);
    renderRows(visibleSlice, startRow);
  }
}

async function loadWindow(offset, limit) {
  if (isLoading) return;
  isLoading = true;
  const requestId = ++lastRequestId;

  try {
    const { data } = await fetchLogs(offset, limit, currentFilters, requestId);
    if (requestId !== lastRequestId) {
      // stale response, ignore
      return;
    }
    currentTotal = data.total;
    rowsData = data.rows;
    currentOffset = offset;

    scroller.style.height = `${currentTotal * rowHeight}px`;
    renderRows(rowsData, offset);
    updateRowCount();
  } catch (e) {
    console.error('Fetch error:', e);
  } finally {
    isLoading = false;
  }
}

function resetAndLoad() {
  currentOffset = 0;
  rowsData = [];
  scroller.innerHTML = '';
  scroller.style.height = '0px';
  container.scrollTop = 0;
  loadWindow(0, 100);
}

function setupEventListeners() {
  severitySelect.addEventListener('change', () => {
    currentFilters.severity = severitySelect.value;
    resetAndLoad();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilters.q = searchInput.value.trim();
      resetAndLoad();
    }, 300);
  });

  container.addEventListener('scroll', () => {
    updateVisibleRows();
  });

  // Initial load of stats
  fetchStats();
}

async function init() {
  setupEventListeners();
  // Initial load
  await loadWindow(0, 100);
  // Set initial scroller height after first load
  scroller.style.height = `${currentTotal * rowHeight}px`;
  updateRowCount();
}

init();