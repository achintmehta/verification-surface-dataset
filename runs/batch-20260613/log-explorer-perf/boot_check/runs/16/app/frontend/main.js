const API_BASE = 'http://localhost:3001/api';

const ROW_HEIGHT = 36;
const CHUNK_SIZE = 100;
const OVERSCAN = 20;

let currentFilters = {
  severity: '',
  q: ''
};

let totalRows = 0;
let corpusTotal = 0;
let rowCache = new Map();
let pendingFetches = new Set();
let fetchAbortController = new AbortController();

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const totalCountEl = document.getElementById('total-count');
const severityBadgesEl = document.getElementById('severity-badges');
const severityFilterEl = document.getElementById('severity-filter');
const searchInputEl = document.getElementById('search-input');

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const stats = await res.json();
    corpusTotal = stats.total;
    renderStats(stats);
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

function renderStats(stats) {
  severityBadgesEl.innerHTML = '';
  const severities = ['debug', 'info', 'warn', 'error'];
  severities.forEach(sev => {
    if (stats.severities[sev]) {
      const badge = document.createElement('div');
      badge.className = `badge ${sev}`;
      badge.textContent = `${sev.toUpperCase()}: ${stats.severities[sev]}`;
      severityBadgesEl.appendChild(badge);
    }
  });
}

async function updateFilters() {
  currentFilters.severity = severityFilterEl.value;
  currentFilters.q = searchInputEl.value;
  
  // Cancel pending fetches
  fetchAbortController.abort();
  fetchAbortController = new AbortController();
  
  rowCache.clear();
  pendingFetches.clear();
  
  // Fetch new total
  await fetchTotal();
  
  viewport.scrollTop = 0;
  renderViewport();
}

async function fetchTotal() {
  const params = new URLSearchParams({
    offset: 0,
    limit: 1,
    ...(currentFilters.severity && { severity: currentFilters.severity }),
    ...(currentFilters.q && { q: currentFilters.q })
  });
  
  try {
    const res = await fetch(`${API_BASE}/logs?${params}`, {
      signal: fetchAbortController.signal
    });
    const data = await res.json();
    totalRows = data.total;
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
    
    if (currentFilters.severity || currentFilters.q) {
      totalCountEl.textContent = `${totalRows} of ${corpusTotal}`;
    } else {
      totalCountEl.textContent = `${totalRows} of ${corpusTotal}`;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to fetch total', err);
    }
  }
}

async function fetchChunk(chunkIndex) {
  if (pendingFetches.has(chunkIndex)) return;
  pendingFetches.add(chunkIndex);
  
  const offset = chunkIndex * CHUNK_SIZE;
  const params = new URLSearchParams({
    offset,
    limit: CHUNK_SIZE,
    ...(currentFilters.severity && { severity: currentFilters.severity }),
    ...(currentFilters.q && { q: currentFilters.q })
  });
  
  try {
    const res = await fetch(`${API_BASE}/logs?${params}`, {
      signal: fetchAbortController.signal
    });
    const data = await res.json();
    
    data.rows.forEach((row, i) => {
      rowCache.set(offset + i, row);
    });
    
    pendingFetches.delete(chunkIndex);
    renderViewport(); // Re-render to show newly fetched rows
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to fetch chunk', err);
      pendingFetches.delete(chunkIndex);
    }
  }
}

function renderViewport() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  if (viewportHeight === 0) return; // Not visible yet
  
  let startRow = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  let endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN;
  
  startRow = Math.max(0, startRow);
  endRow = Math.min(totalRows - 1, endRow);
  
  // Determine which chunks are needed
  const startChunk = Math.floor(startRow / CHUNK_SIZE);
  const endChunk = Math.floor(endRow / CHUNK_SIZE);
  
  for (let c = startChunk; c <= endChunk; c++) {
    if (!isChunkFullyCached(c, totalRows)) {
      fetchChunk(c);
    }
  }
  
  // Render rows
  rowsContainer.innerHTML = '';
  rowsContainer.style.transform = `translateY(${startRow * ROW_HEIGHT}px)`;
  
  const fragment = document.createDocumentFragment();
  
  for (let i = startRow; i <= endRow; i++) {
    const rowData = rowCache.get(i);
    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';
    
    if (rowData) {
      rowEl.innerHTML = `
        <div class="col-ts">${new Date(rowData.ts).toLocaleString()}</div>
        <div class="col-sev sev-${rowData.severity}">${rowData.severity.toUpperCase()}</div>
        <div class="col-svc">${rowData.service}</div>
        <div class="col-msg" title="${escapeHtml(rowData.message)}">${escapeHtml(rowData.message)}</div>
      `;
    } else {
      rowEl.innerHTML = `<div class="col-msg">Loading...</div>`;
    }
    
    fragment.appendChild(rowEl);
  }
  
  rowsContainer.appendChild(fragment);
}

function isChunkFullyCached(chunkIndex, total) {
  const start = chunkIndex * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, total);
  for (let i = start; i < end; i++) {
    if (!rowCache.has(i)) return false;
  }
  return true;
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Event Listeners
viewport.addEventListener('scroll', () => {
  requestAnimationFrame(renderViewport);
});

severityFilterEl.addEventListener('change', updateFilters);

searchInputEl.addEventListener('input', debounce(updateFilters, 300));

// Initialization
async function init() {
  await fetchStats();
  await updateFilters();
  
  // Handle window resize
  window.addEventListener('resize', () => {
    requestAnimationFrame(renderViewport);
  });
}

init();
