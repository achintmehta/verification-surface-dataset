const API_BASE = 'http://localhost:3001/api';

const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let rowCache = new Map();
let inFlightRequests = new Map();
let latestRequestId = 0;

const tableContainer = document.getElementById('table-container');
const virtualScroller = document.getElementById('virtual-scroller');
const statsContainer = document.getElementById('stats-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const loadingIndicator = document.getElementById('loading-indicator');

let globalTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    globalTotal = data.total;
    renderStats(data);
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

function renderStats(data) {
  statsContainer.innerHTML = `
    <div id="visible-count" style="font-weight: bold; margin-bottom: 4px;"></div>
    Total: ${data.total}
    <span class="debug">Debug: ${data.counts.debug}</span>
    <span class="info">Info: ${data.counts.info}</span>
    <span class="warn">Warn: ${data.counts.warn}</span>
    <span class="error">Error: ${data.counts.error}</span>
  `;
  updateVisibleCount(totalRows);
}

function updateVisibleCount(filteredTotal) {
  const visibleCountEl = document.getElementById('visible-count');
  if (visibleCountEl && globalTotal > 0) {
    visibleCountEl.textContent = `${filteredTotal} of ${globalTotal} rows`;
  }
}

async function fetchLogs(offset, limit, severity, q, requestId) {
  const url = new URL(`${API_BASE}/logs`);
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', limit);
  if (severity) url.searchParams.set('severity', severity);
  if (q) url.searchParams.set('q', q);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    
    if (requestId !== latestRequestId) {
      return null; // Stale request
    }
    
    return data;
  } catch (e) {
    console.error('Failed to fetch logs', e);
    return null;
  }
}

function clearCache() {
  rowCache.clear();
  inFlightRequests.clear();
  virtualScroller.innerHTML = '';
}

async function updateFilters() {
  currentSeverity = severityFilter.value;
  currentQuery = searchInput.value;
  
  clearCache();
  latestRequestId++;
  
  // Reset scroll
  tableContainer.scrollTop = 0;
  
  // Fetch initial to get total
  loadingIndicator.style.display = 'block';
  const data = await fetchLogs(0, LIMIT, currentSeverity, currentQuery, latestRequestId);
  loadingIndicator.style.display = 'none';
  
  if (data) {
    totalRows = data.total;
    virtualScroller.style.height = `${totalRows * ROW_HEIGHT}px`;
    updateVisibleCount(totalRows);
    
    // Cache the first batch
    for (let i = 0; i < data.rows.length; i++) {
      rowCache.set(i, data.rows[i]);
    }
    
    renderVisibleRows();
  }
}

function renderRow(index, rowData) {
  let rowEl = document.getElementById(`row-${index}`);
  let isNew = false;
  if (!rowEl) {
    rowEl = document.createElement('div');
    rowEl.id = `row-${index}`;
    rowEl.className = 'log-row';
    rowEl.style.top = `${index * ROW_HEIGHT}px`;
    rowEl.style.height = `${ROW_HEIGHT}px`;
    virtualScroller.appendChild(rowEl);
    isNew = true;
  }
  
  // Only update innerHTML if it's new or transitioning from loading to loaded
  const isLoaded = rowEl.dataset.loaded === 'true';
  if (isNew || (!isLoaded && rowData)) {
    if (rowData) {
      rowEl.innerHTML = `
        <div class="col-ts">${new Date(rowData.ts).toISOString()}</div>
        <div class="col-severity sev-${rowData.severity}">${rowData.severity.toUpperCase()}</div>
        <div class="col-service">${rowData.service}</div>
        <div class="col-message" title="${rowData.message}">${rowData.message}</div>
      `;
      rowEl.dataset.loaded = 'true';
    } else {
      rowEl.innerHTML = `<div style="color: #999; padding-left: 16px;">Loading...</div>`;
      rowEl.dataset.loaded = 'false';
    }
  }
}

async function renderVisibleRows() {
  const scrollTop = tableContainer.scrollTop;
  const viewportHeight = tableContainer.clientHeight;
  
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  
  // Remove rows outside viewport
  const existingRows = Array.from(virtualScroller.children);
  for (const row of existingRows) {
    const index = parseInt(row.id.replace('row-', ''), 10);
    if (index < startIndex || index > endIndex) {
      virtualScroller.removeChild(row);
    }
  }
  
  const missingOffsets = new Set();
  
  for (let i = startIndex; i <= endIndex; i++) {
    if (rowCache.has(i)) {
      renderRow(i, rowCache.get(i));
    } else {
      renderRow(i, null);
      // Calculate which block this belongs to
      const blockOffset = Math.floor(i / LIMIT) * LIMIT;
      missingOffsets.add(blockOffset);
    }
  }
  
  // Fetch missing blocks
  for (const offset of missingOffsets) {
    if (!inFlightRequests.has(offset)) {
      const reqId = latestRequestId;
      const req = fetchLogs(offset, LIMIT, currentSeverity, currentQuery, reqId).then(data => {
        if (data && reqId === latestRequestId) {
          for (let i = 0; i < data.rows.length; i++) {
            rowCache.set(offset + i, data.rows[i]);
          }
          // Re-render if still in viewport
          renderVisibleRows();
        }
        inFlightRequests.delete(offset);
      });
      inFlightRequests.set(offset, req);
    }
  }
}

let debounceTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    updateFilters();
  }, 300);
});

severityFilter.addEventListener('change', () => {
  updateFilters();
});

tableContainer.addEventListener('scroll', () => {
  renderVisibleRows();
});

// Init
fetchStats();
updateFilters();