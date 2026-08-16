const API_BASE = '/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let isLoading = false;
let lastRequestId = 0;

const ROW_HEIGHT = 32;
const VISIBLE_ROWS = 20;
const OVERSCAN = 5;
const BUFFER_SIZE = VISIBLE_ROWS + OVERSCAN * 2;

let scrollTop = 0;
let loadedRows = [];
let loadedOffset = 0;

const table = document.getElementById('virtual-table');
const scroller = document.getElementById('virtual-scroller');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');

let debounceTimer = null;

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const stats = await res.json();
    statsEl.innerHTML = `Total: ${stats.total} | Debug: ${stats.debug} | Info: ${stats.info} | Warn: ${stats.warn} | Error: ${stats.error}`;
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

function updateRowCount() {
  rowCountEl.textContent = `${loadedRows.length} of ${currentTotal} shown`;
}

function renderRows() {
  scroller.innerHTML = '';
  scroller.style.height = `${currentTotal * ROW_HEIGHT}px`;

  if (!loadedRows.length) return;

  const fragment = document.createDocumentFragment();
  loadedRows.forEach((row, index) => {
    const div = document.createElement('div');
    div.className = `log-row severity-${row.severity}`;
    div.style.position = 'absolute';
    div.style.top = `${(loadedOffset + index) * ROW_HEIGHT}px`;
    div.style.height = `${ROW_HEIGHT}px`;
    div.style.width = '100%';
    div.innerHTML = `
      <div class="col-ts">${new Date(row.ts).toISOString()}</div>
      <div class="col-severity">${row.severity.toUpperCase()}</div>
      <div class="col-service">${row.service}</div>
      <div class="col-message">${escapeHtml(row.message)}</div>
    `;
    fragment.appendChild(div);
  });
  scroller.appendChild(fragment);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function fetchWindow(offset, limit) {
  const requestId = ++lastRequestId;
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
    ...(currentFilters.severity && { severity: currentFilters.severity }),
    ...(currentFilters.q && { q: currentFilters.q })
  });

  try {
    const res = await fetch(`${API_BASE}/logs?${params}`);
    if (!res.ok) {
      console.error('API error', res.status);
      return;
    }
    const data = await res.json();
    if (requestId !== lastRequestId) return; // stale response

    currentTotal = data.total;
    loadedRows = data.rows;
    loadedOffset = offset;
    renderRows();
    updateRowCount();
  } catch (e) {
    console.error('Fetch failed', e);
  }
}

function loadVisibleWindow() {
  if (isLoading) return;
  isLoading = true;

  const viewportHeight = table.clientHeight;
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  const neededOffset = Math.max(0, startRow - OVERSCAN);
  const neededLimit = Math.min(200, Math.max(BUFFER_SIZE, endRow - neededOffset + OVERSCAN));

  // Check if we need to fetch new data
  const hasData = loadedRows.length > 0 &&
    neededOffset >= loadedOffset &&
    neededOffset + neededLimit <= loadedOffset + loadedRows.length;

  if (!hasData || currentTotal === 0) {
    fetchWindow(neededOffset, neededLimit).finally(() => {
      isLoading = false;
    });
  } else {
    isLoading = false;
  }
}

function onScroll() {
  scrollTop = table.scrollTop;
  loadVisibleWindow();
}

function resetAndLoad() {
  loadedRows = [];
  loadedOffset = 0;
  scrollTop = 0;
  table.scrollTop = 0;
  scroller.innerHTML = '';
  scroller.style.height = '0px';
  fetchWindow(0, 50).then(() => {
    loadVisibleWindow();
  });
}

function setupEventListeners() {
  severityFilter.addEventListener('change', () => {
    currentFilters.severity = severityFilter.value;
    resetAndLoad();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilters.q = searchInput.value.trim();
      resetAndLoad();
    }, 300);
  });

  table.addEventListener('scroll', onScroll);

  // Initial load
  window.addEventListener('load', () => {
    fetchStats();
    resetAndLoad();
  });
}

setupEventListeners();