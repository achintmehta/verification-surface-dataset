const API_BASE = 'http://localhost:3000/api';

const ROW_HEIGHT = 36;
const OVERSCAN = 10;
const LIMIT = 100;

let corpusTotal = 0;
let filteredTotal = 0;
let currentSeverity = '';
let currentQuery = '';
let loadedData = new Map(); // offset -> row data
let pendingRequests = new Map(); // offset -> AbortController

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDiv = document.getElementById('stats');

let debounceTimer = null;

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    corpusTotal = data.total;
    
    // Update severity dropdown with counts
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (val && data.counts[val] !== undefined) {
        const originalText = options[i].text.split(' (')[0];
        options[i].text = `${originalText} (${data.counts[val]})`;
      } else if (!val) {
        options[i].text = `All Severities (${data.total})`;
      }
    }
    
    updateStatsDisplay();
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

async function fetchLogs(offset) {
  if (loadedData.has(offset)) return;
  if (pendingRequests.has(offset)) return;

  const controller = new AbortController();
  pendingRequests.set(offset, controller);

  try {
    const params = new URLSearchParams({
      offset,
      limit: LIMIT,
    });
    if (currentSeverity) params.set('severity', currentSeverity);
    if (currentQuery) params.set('q', currentQuery);

    const res = await fetch(`${API_BASE}/logs?${params.toString()}`, {
      signal: controller.signal
    });
    
    if (!res.ok) throw new Error('Network response was not ok');
    
    const data = await res.json();
    
    filteredTotal = data.total;
    spacer.style.height = `${filteredTotal * ROW_HEIGHT}px`;
    updateStatsDisplay();

    for (let i = 0; i < data.rows.length; i++) {
      loadedData.set(offset + i, data.rows[i]);
    }
    
    renderViewport();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Failed to fetch logs', e);
    }
  } finally {
    pendingRequests.delete(offset);
  }
}

function updateStatsDisplay() {
  if (corpusTotal > 0) {
    statsDiv.textContent = `${filteredTotal} of ${corpusTotal}`;
  } else {
    statsDiv.textContent = `${filteredTotal} rows`;
  }
}

let rowElements = [];

function renderViewport() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  
  const renderStart = Math.max(0, startRow - OVERSCAN);
  const renderEnd = Math.min(filteredTotal, endRow + OVERSCAN);
  const rowCount = renderEnd - renderStart;
  
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  
  // Adjust number of DOM elements
  while (rowElements.length < rowCount) {
    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';
    
    const tsEl = document.createElement('div');
    tsEl.className = 'col-ts';
    
    const sevEl = document.createElement('div');
    sevEl.className = 'col-sev';
    
    const svcEl = document.createElement('div');
    svcEl.className = 'col-svc';
    
    const msgEl = document.createElement('div');
    msgEl.className = 'col-msg';
    
    rowEl.appendChild(tsEl);
    rowEl.appendChild(sevEl);
    rowEl.appendChild(svcEl);
    rowEl.appendChild(msgEl);
    
    rowsContainer.appendChild(rowEl);
    rowElements.push({ rowEl, tsEl, sevEl, svcEl, msgEl });
  }
  
  while (rowElements.length > rowCount) {
    const el = rowElements.pop();
    rowsContainer.removeChild(el.rowEl);
  }
  
  let missingOffsets = new Set();
  
  for (let i = 0; i < rowCount; i++) {
    const rowIndex = renderStart + i;
    const rowData = loadedData.get(rowIndex);
    const els = rowElements[i];
    
    if (rowData) {
      els.tsEl.textContent = new Date(rowData.ts).toLocaleString();
      els.sevEl.className = `col-sev sev-${rowData.severity}`;
      els.sevEl.textContent = rowData.severity.toUpperCase();
      els.svcEl.textContent = rowData.service;
      els.msgEl.textContent = rowData.message;
      els.tsEl.style.display = '';
      els.sevEl.style.display = '';
      els.svcEl.style.display = '';
      els.msgEl.style.display = '';
      els.rowEl.textContent = '';
      els.rowEl.appendChild(els.tsEl);
      els.rowEl.appendChild(els.sevEl);
      els.rowEl.appendChild(els.svcEl);
      els.rowEl.appendChild(els.msgEl);
    } else {
      els.rowEl.textContent = 'Loading...';
      const chunkOffset = Math.floor(rowIndex / LIMIT) * LIMIT;
      missingOffsets.add(chunkOffset);
    }
  }
  
  for (const offset of missingOffsets) {
    fetchLogs(offset);
  }
}

function resetAndFetch() {
  // Cancel all pending requests
  for (const controller of pendingRequests.values()) {
    controller.abort();
  }
  pendingRequests.clear();
  loadedData.clear();
  
  viewport.scrollTop = 0;
  filteredTotal = 0;
  spacer.style.height = '0px';
  renderViewport();
  
  // Fetch initial chunk
  fetchLogs(0);
}

viewport.addEventListener('scroll', () => {
  renderViewport();
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

searchInput.addEventListener('input', (e) => {
  currentQuery = e.target.value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    resetAndFetch();
  }, 300);
});

// Initial load
fetchStats().then(() => {
  resetAndFetch();
});
