const API_BASE = 'http://localhost:3001';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let isLoading = false;
let lastRequestId = 0;

const tbody = document.getElementById('log-tbody');
const container = document.getElementById('table-container');
const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const spacer = document.getElementById('virtual-spacer');

const ROW_HEIGHT = 32; // approx px per row
const VISIBLE_ROWS = Math.ceil(600 / ROW_HEIGHT) + 5; // viewport + overscan
const OVERSCAN = 5;

let rowsData = [];
let scrollTop = 0;
let currentOffset = 0;

async function fetchLogs(offset, limit, filters, requestId) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
    ...(filters.severity && { severity: filters.severity }),
    ...(filters.q && { q: filters.q })
  });
  
  const res = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!res.ok) throw new Error('Fetch failed');
  const data = await res.json();
  return { data, requestId };
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  return res.json();
}

function updateRowCount(filteredTotal) {
  rowCountEl.textContent = `${rowsData.length} of ${filteredTotal.toLocaleString()}`;
}

function renderRows(startIndex, data) {
  tbody.innerHTML = '';
  rowsData = data;
  
  data.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(row.ts).toISOString()}</td>
      <td class="${row.severity}">${row.severity}</td>
      <td>${row.service}</td>
      <td title="${row.message}">${row.message}</td>
    `;
    tbody.appendChild(tr);
  });
  
  // Update spacer for total height
  const totalHeight = currentTotal * ROW_HEIGHT;
  spacer.style.height = `${totalHeight}px`;
  
  // Position the table body relatively? For virtualization, better to use absolute or transform.
  // Simple impl: set margin or use padding on tbody? For basic, we adjust scroll.
}

function positionRows(offset) {
  // For true virtualization, we'd set top padding or transform, but simple version:
  // Since we fetch window, we can set the tbody's first row position by adjusting container scroll or use padding.
  // To make it work, we'll use a top padding on tbody or a virtual top.
  const topOffsetPx = offset * ROW_HEIGHT;
  tbody.style.paddingTop = `${topOffsetPx}px`;
}

async function loadWindow(offset, filters, force = false) {
  if (isLoading && !force) return;
  isLoading = true;
  
  const requestId = ++lastRequestId;
  const limit = 100; // window size
  
  try {
    const { data, requestId: rid } = await fetchLogs(offset, limit, filters, requestId);
    if (rid !== lastRequestId) {
      // stale response
      return;
    }
    
    currentTotal = data.total;
    currentOffset = offset;
    
    renderRows(offset, data.rows);
    positionRows(offset);
    updateRowCount(currentTotal);
  } catch (e) {
    console.error(e);
  } finally {
    isLoading = false;
  }
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function resetAndLoad() {
  tbody.innerHTML = '';
  tbody.style.paddingTop = '0px';
  spacer.style.height = '0px';
  rowsData = [];
  currentOffset = 0;
  loadWindow(0, currentFilters);
}

function setupEventListeners() {
  severitySelect.addEventListener('change', () => {
    currentFilters.severity = severitySelect.value;
    resetAndLoad();
  });
  
  const debouncedSearch = debounce(() => {
    currentFilters.q = searchInput.value.trim();
    resetAndLoad();
  }, 300);
  
  searchInput.addEventListener('input', debouncedSearch);
  
  // Virtualization scroll handler
  let scrollTimeout;
  container.addEventListener('scroll', () => {
    const scrollTop = container.scrollTop;
    const estimatedRow = Math.floor(scrollTop / ROW_HEIGHT);
    
    // If scrolled outside current window, fetch new window
    const windowStart = currentOffset;
    const windowEnd = currentOffset + 100;
    
    if (estimatedRow < windowStart - 20 || estimatedRow > windowEnd + 20) {
      const newOffset = Math.max(0, estimatedRow - 20);
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        loadWindow(newOffset, currentFilters);
      }, 50);
    }
  });
  
  // Initial load stats for badges? but simple, no badges impl beyond count
}

async function init() {
  setupEventListeners();
  
  // Initial load
  await loadWindow(0, currentFilters);
  
  // Optional: load stats
  // const stats = await fetchStats();
}

init();