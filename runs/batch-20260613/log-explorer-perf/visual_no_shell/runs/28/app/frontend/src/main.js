const API_BASE = 'http://localhost:3001/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 42;
let visibleRows = 15; // approx
let overscan = 5;
let isLoading = false;
let lastRequestId = 0;
let debounceTimer = null;

const tbody = document.getElementById('log-tbody');
const scroller = document.getElementById('virtual-scroller');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let renderedRows = new Map(); // offset -> row element

function updateRowCount() {
  rowCountEl.textContent = `${currentTotal.toLocaleString()} rows`;
}

async function fetchLogs(offset, limit, signal) {
  const params = new URLSearchParams({
    offset: Math.max(0, offset),
    limit: Math.min(200, limit)
  });
  if (currentFilter.severity) params.set('severity', currentFilter.severity);
  if (currentFilter.q) params.set('q', currentFilter.q);
  
  const res = await fetch(`${API_BASE}/logs?${params}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch');
  }
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  return res.json();
}

function createRowElement(log, index) {
  const tr = document.createElement('tr');
  tr.className = `log-row severity-${log.severity}`;
  tr.style.position = 'absolute';
  tr.style.top = `${index * rowHeight}px`;
  tr.style.height = `${rowHeight}px`;
  tr.style.width = '100%';
  tr.style.display = 'table';
  tr.style.tableLayout = 'fixed';
  
  const ts = new Date(log.ts).toLocaleString();
  tr.innerHTML = `
    <td style="width: 180px;">${ts}</td>
    <td style="width: 80px;"><span class="severity-${log.severity}">${log.severity}</span></td>
    <td style="width: 100px;">${log.service}</td>
    <td>${log.message}</td>
  `;
  return tr;
}

function renderWindow(startOffset, rows) {
  // Clear previous
  tbody.innerHTML = '';
  renderedRows.clear();
  
  // Set tbody height to simulate total
  tbody.style.position = 'relative';
  tbody.style.height = `${currentTotal * rowHeight}px`;
  
  rows.forEach((log, i) => {
    const globalIndex = startOffset + i;
    const tr = createRowElement(log, globalIndex);
    tbody.appendChild(tr);
    renderedRows.set(globalIndex, tr);
  });
}

function updateVisibleWindow() {
  if (!currentTotal) return;
  
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  
  const startRow = Math.floor(scrollTop / rowHeight);
  const endRow = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  const startOffset = Math.max(0, startRow - overscan);
  const numRows = Math.min(200, endRow - startOffset + 1);
  
  if (numRows <= 0) return;
  
  const requestId = ++lastRequestId;
  
  fetchLogs(startOffset, numRows).then(data => {
    if (requestId !== lastRequestId) return; // stale
    
    // Update total if changed (e.g. filter)
    if (data.total !== currentTotal) {
      currentTotal = data.total;
      updateRowCount();
      tbody.style.height = `${currentTotal * rowHeight}px`;
    }
    
    renderWindow(startOffset, data.rows);
  }).catch(err => {
    if (requestId === lastRequestId) {
      console.error('Fetch error:', err);
    }
  });
}

function resetAndLoad() {
  currentTotal = 0;
  tbody.innerHTML = '';
  renderedRows.clear();
  tbody.style.height = '0px';
  
  // Initial load to get total and first rows
  const requestId = ++lastRequestId;
  fetchLogs(0, 50).then(data => {
    if (requestId !== lastRequestId) return;
    currentTotal = data.total;
    updateRowCount();
    tbody.style.height = `${currentTotal * rowHeight}px`;
    renderWindow(0, data.rows);
    // Set initial scroll
    scroller.scrollTop = 0;
  }).catch(console.error);
}

function debounceSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentFilter.q = searchInput.value.trim();
    resetAndLoad();
  }, 300);
}

function setupEventListeners() {
  severitySelect.addEventListener('change', () => {
    currentFilter.severity = severitySelect.value;
    resetAndLoad();
  });
  
  searchInput.addEventListener('input', debounceSearch);
  
  scroller.addEventListener('scroll', () => {
    // Throttle scroll updates
    if (!isLoading) {
      isLoading = true;
      requestAnimationFrame(() => {
        updateVisibleWindow();
        isLoading = false;
      });
    }
  });
  
  // Handle window resize
  window.addEventListener('resize', () => {
    updateVisibleWindow();
  });
}

async function init() {
  setupEventListeners();
  
  // Initial load
  try {
    const stats = await fetchStats();
    currentTotal = stats.total;
    updateRowCount();
    
    // Load first page
    const data = await fetchLogs(0, 50);
    currentTotal = data.total;
    updateRowCount();
    tbody.style.height = `${currentTotal * rowHeight}px`;
    renderWindow(0, data.rows);
  } catch (err) {
    console.error('Init error:', err);
    tbody.innerHTML = `<tr><td colspan="4">Failed to load logs. Is backend running?</td></tr>`;
  }
  
  // Initial visible window setup
  setTimeout(() => {
    updateVisibleWindow();
  }, 100);
}

init();