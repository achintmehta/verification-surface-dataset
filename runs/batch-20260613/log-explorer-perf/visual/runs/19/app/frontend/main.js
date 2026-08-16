const API_URL = 'http://localhost:3001/api';
const ROW_HEIGHT = 36;
const OVERSCAN = 20;
const LIMIT = 100;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let logsCache = new Map(); // offset -> row data
let pendingRequests = new Map(); // offset -> AbortController
let latestFetchId = 0;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    document.getElementById('total-count').textContent = data.total;
    document.getElementById('debug-count').textContent = data.counts.debug;
    document.getElementById('info-count').textContent = data.counts.info;
    document.getElementById('warn-count').textContent = data.counts.warn;
    document.getElementById('error-count').textContent = data.counts.error;
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

async function fetchLogs(offset) {
  // Align offset to LIMIT
  const alignedOffset = Math.floor(offset / LIMIT) * LIMIT;
  
  if (logsCache.has(alignedOffset)) {
    return;
  }
  
  if (pendingRequests.has(alignedOffset)) {
    return;
  }

  const controller = new AbortController();
  pendingRequests.set(alignedOffset, controller);

  const fetchId = ++latestFetchId;

  try {
    const params = new URLSearchParams({
      offset: alignedOffset,
      limit: LIMIT
    });
    if (currentSeverity) params.append('severity', currentSeverity);
    if (currentQuery) params.append('q', currentQuery);

    const res = await fetch(`${API_URL}/logs?${params.toString()}`, {
      signal: controller.signal
    });
    const data = await res.json();

    // If filters changed while fetching, discard
    if (fetchId !== latestFetchId) return;

    totalRows = data.total;
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
    document.getElementById('filtered-count').textContent = totalRows;

    for (let i = 0; i < data.rows.length; i++) {
      logsCache.set(alignedOffset + i, data.rows[i]);
    }

    renderVisibleRows();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to fetch logs', err);
    }
  } finally {
    pendingRequests.delete(alignedOffset);
  }
}

const rowPool = [];

function getRowElement() {
  if (rowPool.length > 0) {
    return rowPool.pop();
  }
  const el = document.createElement('div');
  el.className = 'row';
  return el;
}

function releaseRowElement(el) {
  rowPool.push(el);
}

function renderVisibleRows() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  let startIndex = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  let endIndex = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN;
  
  startIndex = Math.max(0, startIndex);
  endIndex = Math.min(totalRows - 1, endIndex);

  if (totalRows === 0) {
    while (rowsContainer.firstChild) {
      releaseRowElement(rowsContainer.firstChild);
      rowsContainer.removeChild(rowsContainer.firstChild);
    }
    if (pendingRequests.size > 0) {
      rowsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: #666;">Loading...</div>';
    } else {
      rowsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: #666;">No logs found</div>';
    }
    rowsContainer.style.transform = `translateY(0px)`;
    return;
  }

  // Clear "No logs found" message if present
  if (rowsContainer.firstChild && !rowsContainer.firstChild.classList?.contains('row')) {
    rowsContainer.innerHTML = '';
  }

  const startChunk = Math.floor(startIndex / LIMIT) * LIMIT;
  const endChunk = Math.floor(endIndex / LIMIT) * LIMIT;
  for (let i = startChunk; i <= endChunk; i += LIMIT) {
    fetchLogs(i);
  }

  // Recycle existing nodes
  const existingNodes = Array.from(rowsContainer.children);
  for (const node of existingNodes) {
    releaseRowElement(node);
  }
  rowsContainer.innerHTML = '';

  const fragment = document.createDocumentFragment();
  for (let i = startIndex; i <= endIndex; i++) {
    const rowData = logsCache.get(i);
    const rowEl = getRowElement();
    rowEl.className = `row ${rowData ? rowData.severity : ''}`;
    
    if (rowData) {
      rowEl.innerHTML = `
        <div class="col-ts">${new Date(rowData.ts).toLocaleString()}</div>
        <div class="col-severity">${rowData.severity}</div>
        <div class="col-service">${rowData.service}</div>
        <div class="col-message" title="${escapeHtml(rowData.message)}">${escapeHtml(rowData.message)}</div>
      `;
    } else {
      rowEl.innerHTML = `<div style="padding-left: 16px; color: #999;">Loading...</div>`;
    }
    fragment.appendChild(rowEl);
  }

  rowsContainer.appendChild(fragment);
  rowsContainer.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function resetAndFetch() {
  // Cancel all pending requests
  for (const controller of pendingRequests.values()) {
    controller.abort();
  }
  pendingRequests.clear();
  logsCache.clear();
  latestFetchId++;
  
  viewport.scrollTop = 0;
  totalRows = 0;
  spacer.style.height = '0px';
  
  while (rowsContainer.firstChild) {
    if (rowsContainer.firstChild.classList?.contains('row')) {
      releaseRowElement(rowsContainer.firstChild);
    }
    rowsContainer.removeChild(rowsContainer.firstChild);
  }
  
  fetchLogs(0);
}

let debounceTimer;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = e.target.value.trim();
    resetAndFetch();
  }, 300);
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

viewport.addEventListener('scroll', () => {
  renderVisibleRows();
});

// Initial load
fetchStats();
resetAndFetch();
