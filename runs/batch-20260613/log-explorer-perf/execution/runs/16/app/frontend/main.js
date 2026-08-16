const API_URL = 'http://localhost:3001/api';

const ROW_HEIGHT = 36;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let logsCache = new Map(); // offset -> promise/data
let abortController = null;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDiv = document.getElementById('stats');

let globalTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const stats = await res.json();
    globalTotal = stats.total;
    updateStatsDisplay();
    
    // Update severity dropdown with counts
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (val && stats.severities[val]) {
        options[i].textContent = `${val.charAt(0).toUpperCase() + val.slice(1)} (${stats.severities[val].toLocaleString()})`;
      } else if (!val) {
        options[i].textContent = `All Severities (${globalTotal.toLocaleString()})`;
      }
    }
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

function updateStatsDisplay() {
  if (globalTotal > 0) {
    statsDiv.textContent = `${totalRows.toLocaleString()} of ${globalTotal.toLocaleString()} rows`;
  } else {
    statsDiv.textContent = `${totalRows.toLocaleString()} rows`;
  }
}

async function fetchLogs(offset, signal) {
  const params = new URLSearchParams({
    offset,
    limit: LIMIT,
  });
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);
  
  try {
    const res = await fetch(`${API_URL}/logs?${params.toString()}`, { signal });
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    return data;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('Failed to fetch logs', err);
    return { total: 0, rows: [] };
  }
}

let latestFetchId = 0;

async function updateView() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  
  let renderStart = Math.max(0, startRow - OVERSCAN);
  let renderEnd = totalRows > 0 ? Math.min(totalRows, endRow + OVERSCAN) : endRow + OVERSCAN;
  
  const chunksNeeded = new Set();
  for (let i = renderStart; i < renderEnd; i++) {
    chunksNeeded.add(Math.floor(i / LIMIT) * LIMIT);
  }
  
  const fetchId = ++latestFetchId;
  const filterId = currentFilterId;
  let fetchedTotal = totalRows;
  let promises = [];
  
  for (const offset of chunksNeeded) {
    if (!logsCache.has(offset)) {
      const promise = fetchLogs(offset, abortController.signal).then(data => {
        if (filterId !== currentFilterId) return null; // Stale filter
        if (data) {
          logsCache.set(offset, data.rows);
          return { offset, total: data.total };
        }
        return null;
      });
      logsCache.set(offset, promise);
    }
    
    const cached = logsCache.get(offset);
    if (cached instanceof Promise) {
      promises.push(cached);
    }
  }
  
  if (promises.length > 0) {
    const results = await Promise.all(promises);
    if (fetchId !== latestFetchId) return; // Stale
    
    for (const res of results) {
      if (res && res.total !== undefined) {
        fetchedTotal = res.total;
      }
    }
  }
  
  if (fetchId !== latestFetchId) return;
  
  if (fetchedTotal !== totalRows || totalRows === 0) {
    totalRows = fetchedTotal;
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
    updateStatsDisplay();
    renderEnd = Math.min(totalRows, endRow + OVERSCAN);
  }
  
  // Render rows
  rowsContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();
  
  for (let i = renderStart; i < renderEnd; i++) {
    const rowData = getRowData(i);
    
    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';
    rowEl.style.position = 'absolute';
    rowEl.style.top = `${i * ROW_HEIGHT}px`;
    rowEl.style.left = '0';
    rowEl.style.right = '0';
    
    if (rowData) {
      const tsEl = document.createElement('div');
      tsEl.className = 'col-ts';
      tsEl.textContent = new Date(rowData.ts).toLocaleString();
      
      const sevEl = document.createElement('div');
      sevEl.className = `col-sev sev-${rowData.severity}`;
      sevEl.textContent = rowData.severity.toUpperCase();
      
      const svcEl = document.createElement('div');
      svcEl.className = 'col-svc';
      svcEl.textContent = rowData.service;
      
      const msgEl = document.createElement('div');
      msgEl.className = 'col-msg';
      msgEl.textContent = rowData.message;
      msgEl.title = rowData.message;
      
      rowEl.appendChild(tsEl);
      rowEl.appendChild(sevEl);
      rowEl.appendChild(svcEl);
      rowEl.appendChild(msgEl);
    } else {
      rowEl.textContent = 'Loading...';
    }
    
    fragment.appendChild(rowEl);
  }
  
  rowsContainer.appendChild(fragment);
}

function getRowData(index) {
  const chunkOffset = Math.floor(index / LIMIT) * LIMIT;
  const cached = logsCache.get(chunkOffset);
  if (Array.isArray(cached)) {
    const localIndex = index - chunkOffset;
    return cached[localIndex];
  }
  return null;
}

let currentFilterId = 0;

function resetAndFetch() {
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();
  currentFilterId++;
  logsCache.clear();
  totalRows = 0;
  spacer.style.height = '0px';
  viewport.scrollTop = 0;
  updateView();
}

let debounceTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    currentQuery = e.target.value.trim();
    resetAndFetch();
  }, 300);
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

let scrollTicking = false;
viewport.addEventListener('scroll', () => {
  if (!scrollTicking) {
    window.requestAnimationFrame(() => {
      updateView();
      scrollTicking = false;
    });
    scrollTicking = true;
  }
});

// Initial load
abortController = new AbortController();
fetchStats();
updateView();