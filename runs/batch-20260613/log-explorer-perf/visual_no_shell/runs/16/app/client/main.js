const ROW_HEIGHT = 30;
const CHUNK_SIZE = 100;
const API_URL = 'http://localhost:3001/api';

let totalRows = 0;
let rowCache = new Map();
let inFlightChunks = new Set();
let currentAbortController = null;

let currentSeverity = '';
let currentSearch = '';

const container = document.getElementById('log-container');
const scrollContent = document.getElementById('log-scroll-content');
const statsEl = document.getElementById('stats');
const severitySelect = document.getElementById('severity');
const searchInput = document.getElementById('search');

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

let absoluteTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    absoluteTotal = data.total;
    updateStats();
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

async function fetchChunk(chunkIndex, signal) {
  if (inFlightChunks.has(chunkIndex)) return;
  inFlightChunks.add(chunkIndex);

  const offset = chunkIndex * CHUNK_SIZE;
  const params = new URLSearchParams({
    offset,
    limit: CHUNK_SIZE
  });
  if (currentSeverity) params.append('severity', currentSeverity);
  if (currentSearch) params.append('q', currentSearch);

  try {
    const res = await fetch(`${API_URL}/logs?${params.toString()}`, { signal });
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    
    totalRows = data.total;
    scrollContent.style.height = `${totalRows * ROW_HEIGHT}px`;
    updateStats();

    data.rows.forEach((row, i) => {
      rowCache.set(offset + i, row);
    });

    renderVisibleRows();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Failed to fetch chunk', e);
    }
  } finally {
    if (!signal.aborted) {
      inFlightChunks.delete(chunkIndex);
    }
  }
}

function updateStats() {
  if (absoluteTotal > 0) {
    statsEl.textContent = `${totalRows.toLocaleString()} of ${absoluteTotal.toLocaleString()} rows`;
  } else {
    statsEl.textContent = `${totalRows.toLocaleString()} rows`;
  }
}

function renderVisibleRows() {
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;
  
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT);
  const endIndex = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT));
  
  // Overscan
  const overscan = 10;
  const renderStart = Math.max(0, startIndex - overscan);
  const renderEnd = Math.min(totalRows - 1, endIndex + overscan);

  // Determine which chunks we need
  const startChunk = Math.floor(renderStart / CHUNK_SIZE);
  const endChunk = Math.floor(renderEnd / CHUNK_SIZE);

  for (let c = startChunk; c <= endChunk; c++) {
    let hasAll = true;
    for (let i = c * CHUNK_SIZE; i < Math.min(totalRows, (c + 1) * CHUNK_SIZE); i++) {
      if (!rowCache.has(i)) {
        hasAll = false;
        break;
      }
    }
    if (!hasAll) {
      fetchChunk(c, currentAbortController.signal);
    }
  }

  // Render rows
  const fragment = document.createDocumentFragment();
  for (let i = renderStart; i <= renderEnd; i++) {
    const rowData = rowCache.get(i);
    
    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';
    rowEl.style.top = `${i * ROW_HEIGHT}px`;
    
    if (rowData) {
      const tsEl = document.createElement('div');
      tsEl.className = 'col-ts';
      tsEl.textContent = new Date(rowData.ts).toLocaleString();
      
      const sevEl = document.createElement('div');
      sevEl.className = `col-severity sev-${rowData.severity}`;
      sevEl.textContent = rowData.severity.toUpperCase();
      
      const srvEl = document.createElement('div');
      srvEl.className = 'col-service';
      srvEl.textContent = rowData.service;
      
      const msgEl = document.createElement('div');
      msgEl.className = 'col-message';
      msgEl.textContent = rowData.message;
      
      rowEl.appendChild(tsEl);
      rowEl.appendChild(sevEl);
      rowEl.appendChild(srvEl);
      rowEl.appendChild(msgEl);
    } else {
      rowEl.textContent = 'Loading...';
    }
    
    fragment.appendChild(rowEl);
  }
  
  scrollContent.innerHTML = '';
  scrollContent.appendChild(fragment);
}

function resetAndFetch() {
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  
  rowCache.clear();
  inFlightChunks.clear();
  totalRows = 0;
  scrollContent.style.height = '0px';
  container.scrollTop = 0;
  
  // Fetch first chunk to get total and initial rows
  fetchChunk(0, currentAbortController.signal);
}

container.addEventListener('scroll', () => {
  window.requestAnimationFrame(renderVisibleRows);
});

severitySelect.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

searchInput.addEventListener('input', debounce((e) => {
  currentSearch = e.target.value;
  resetAndFetch();
}, 300));

// Initial load
fetchStats();
resetAndFetch();
