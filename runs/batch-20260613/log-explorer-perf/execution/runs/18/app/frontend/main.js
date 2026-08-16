const ROW_HEIGHT = 30;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let abortController = null;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDiv = document.getElementById('stats');

let loadedData = new Map(); // offset -> row data
let fetchingOffsets = new Set();
let globalStats = { total: 0, counts: {} };

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    globalStats = data;
    updateStatsDisplay();
    
    // Update severity dropdown with counts
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (val && data.counts[val] !== undefined) {
        const baseText = val.charAt(0).toUpperCase() + val.slice(1);
        options[i].textContent = `${baseText} (${data.counts[val]})`;
      }
    }
  } catch (e) {
    console.error(e);
  }
}

function updateStatsDisplay() {
  let filters = [];
  if (currentSeverity) filters.push(`severity: ${currentSeverity}`);
  if (currentQuery) filters.push(`search: "${currentQuery}"`);
  
  if (filters.length > 0) {
    statsDiv.textContent = `${totalRows} of ${globalStats.total} rows (Filtered by ${filters.join(', ')})`;
  } else {
    statsDiv.textContent = `${totalRows} rows total`;
  }
}

async function fetchLogs(offset) {
  if (fetchingOffsets.has(offset)) return;
  fetchingOffsets.add(offset);

  const url = new URL('/api/logs', window.location.origin);
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', LIMIT);
  if (currentSeverity) url.searchParams.set('severity', currentSeverity);
  if (currentQuery) url.searchParams.set('q', currentQuery);

  try {
    const res = await fetch(url, { signal: abortController.signal });
    const data = await res.json();
    
    totalRows = data.total;
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
    
    updateStatsDisplay();

    data.rows.forEach((row, i) => {
      loadedData.set(offset + i, row);
    });

    renderVisibleRows();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
    }
  } finally {
    fetchingOffsets.delete(offset);
  }
}

function renderVisibleRows() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;

  const startIdx = Math.floor(scrollTop / ROW_HEIGHT);
  const endIdx = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const renderStart = Math.max(0, startIdx - OVERSCAN);
  const renderEnd = Math.min(totalRows - 1, endIdx + OVERSCAN);

  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;

  const requiredRows = renderEnd - renderStart + 1;
  const currentRows = rowsContainer.children.length;

  // Add missing DOM elements
  for (let i = currentRows; i < requiredRows; i++) {
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
  }

  // Remove extra DOM elements
  while (rowsContainer.children.length > requiredRows) {
    rowsContainer.removeChild(rowsContainer.lastChild);
  }

  let missingOffsets = new Set();

  for (let i = renderStart; i <= renderEnd; i++) {
    const rowIdx = i - renderStart;
    const rowEl = rowsContainer.children[rowIdx];
    const rowData = loadedData.get(i);

    if (rowData) {
      rowEl.className = `log-row ${rowData.severity}`;
      rowEl.children[0].textContent = new Date(rowData.ts).toLocaleString();
      rowEl.children[1].textContent = rowData.severity;
      rowEl.children[2].textContent = rowData.service;
      rowEl.children[3].textContent = rowData.message;
    } else {
      rowEl.className = 'log-row';
      rowEl.children[0].textContent = 'Loading...';
      rowEl.children[1].textContent = '';
      rowEl.children[2].textContent = '';
      rowEl.children[3].textContent = '';

      const chunkOffset = Math.floor(i / LIMIT) * LIMIT;
      missingOffsets.add(chunkOffset);
    }
  }

  missingOffsets.forEach(offset => {
    fetchLogs(offset);
  });
}

function resetAndFetch() {
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();
  
  loadedData.clear();
  fetchingOffsets.clear();
  totalRows = 0;
  spacer.style.height = '0px';
  rowsContainer.innerHTML = '';
  viewport.scrollTop = 0;
  
  fetchLogs(0);
}

let debounceTimer;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = e.target.value;
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
