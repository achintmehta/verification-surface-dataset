const API_URL = 'http://localhost:3001/api';

const state = {
  total: 0,
  rows: [],
  severity: '',
  q: '',
  rowHeight: 32,
  scrollTop: 0,
  viewportHeight: 0,
  loadedOffset: -1,
  loadedLimit: 0,
  isLoading: false,
  pendingRequest: null
};

let globalTotal = 0;

const elements = {
  severityFilter: document.getElementById('severity-filter'),
  searchInput: document.getElementById('search-input'),
  statsDisplay: document.getElementById('stats-display'),
  logContainer: document.getElementById('log-container'),
  logScrollContent: document.getElementById('log-scroll-content')
};

let debounceTimer = null;
let fetchAbortController = null;

const activeRows = new Map();
const rowPool = [];

function createRowElement() {
  const rowEl = document.createElement('div');
  rowEl.className = 'log-row';
  
  const tsEl = document.createElement('div');
  tsEl.className = 'col-ts';
  
  const sevEl = document.createElement('div');
  
  const svcEl = document.createElement('div');
  svcEl.className = 'col-svc';
  
  const msgEl = document.createElement('div');
  msgEl.className = 'col-msg';
  
  rowEl.appendChild(tsEl);
  rowEl.appendChild(sevEl);
  rowEl.appendChild(svcEl);
  rowEl.appendChild(msgEl);
  
  return { rowEl, tsEl, sevEl, svcEl, msgEl };
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const stats = await res.json();
    globalTotal = stats.total;
    updateStatsDisplay();
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

async function fetchLogs(offset, limit) {
  if (fetchAbortController) {
    fetchAbortController.abort();
  }
  fetchAbortController = new AbortController();

  const params = new URLSearchParams({
    offset,
    limit
  });
  if (state.severity) params.append('severity', state.severity);
  if (state.q) params.append('q', state.q);

  try {
    state.isLoading = true;
    const res = await fetch(`${API_URL}/logs?${params.toString()}`, {
      signal: fetchAbortController.signal
    });
    const data = await res.json();
    
    state.total = data.total;
    state.rows = data.rows;
    state.loadedOffset = offset;
    state.loadedLimit = limit;
    
    updateScrollHeight();
    renderVisibleRows();
    updateStatsDisplay();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to fetch logs', err);
    }
  } finally {
    state.isLoading = false;
    checkAndFetch();
  }
}

function checkAndFetch() {
  const { scrollTop, viewportHeight, rowHeight, total, loadedOffset, loadedLimit } = state;
  
  if (total === 0 && loadedOffset !== -1) return;

  const startIndex = Math.floor(scrollTop / rowHeight);
  const endIndex = Math.min(Math.max(0, total - 1), Math.floor((scrollTop + viewportHeight) / rowHeight));
  
  const overscan = 50;
  let fetchStartIndex = Math.max(0, startIndex - overscan);
  let fetchLimit = 200;
  
  if (fetchStartIndex + fetchLimit > total && total > 0) {
    fetchStartIndex = Math.max(0, total - fetchLimit);
  }

  const effectiveEndIndex = Math.min(endIndex, startIndex + 199);
  
  const needsFetch = loadedOffset === -1 || 
                     startIndex < loadedOffset || 
                     effectiveEndIndex >= loadedOffset + loadedLimit;

  if (needsFetch && !state.isLoading) {
    fetchLogs(fetchStartIndex, fetchLimit);
  }
}

function updateScrollHeight() {
  elements.logScrollContent.style.height = `${state.total * state.rowHeight}px`;
}

function updateStatsDisplay() {
  if (globalTotal > 0) {
    elements.statsDisplay.textContent = `${state.total} of ${globalTotal} rows`;
  } else {
    elements.statsDisplay.textContent = `${state.total} rows`;
  }
}

function renderVisibleRows() {
  const { scrollTop, viewportHeight, rowHeight, total, rows, loadedOffset } = state;
  
  checkAndFetch();

  if (total === 0) {
    for (const [rowIndex, rowObj] of activeRows.entries()) {
      elements.logScrollContent.removeChild(rowObj.rowEl);
      rowPool.push(rowObj);
    }
    activeRows.clear();
    return;
  }

  const startIndex = Math.floor(scrollTop / rowHeight);
  const endIndex = Math.min(total - 1, Math.floor((scrollTop + viewportHeight) / rowHeight));

  for (const [rowIndex, rowObj] of activeRows.entries()) {
    if (rowIndex < startIndex || rowIndex > endIndex) {
      elements.logScrollContent.removeChild(rowObj.rowEl);
      rowPool.push(rowObj);
      activeRows.delete(rowIndex);
    }
  }

  for (let i = startIndex; i <= endIndex; i++) {
    const dataIndex = i - loadedOffset;
    const rowData = rows[dataIndex];
    
    if (rowData) {
      let rowObj = activeRows.get(i);
      if (!rowObj) {
        rowObj = rowPool.length > 0 ? rowPool.pop() : createRowElement();
        activeRows.set(i, rowObj);
        elements.logScrollContent.appendChild(rowObj.rowEl);
      }
      
      rowObj.rowEl.style.top = `${i * rowHeight}px`;
      rowObj.tsEl.textContent = new Date(rowData.ts).toISOString().replace('T', ' ').substring(0, 19);
      rowObj.sevEl.className = `col-sev sev-${rowData.severity}`;
      rowObj.sevEl.textContent = rowData.severity.toUpperCase();
      rowObj.svcEl.textContent = rowData.service;
      rowObj.msgEl.textContent = rowData.message;
    }
  }
}

function handleScroll() {
  state.scrollTop = elements.logContainer.scrollTop;
  renderVisibleRows();
}

function handleResize() {
  state.viewportHeight = elements.logContainer.clientHeight;
  renderVisibleRows();
}

function applyFilters() {
  state.severity = elements.severityFilter.value;
  state.q = elements.searchInput.value.trim();
  state.loadedOffset = -1;
  state.rows = [];
  state.total = 0;
  elements.logContainer.scrollTop = 0;
  state.scrollTop = 0;
  
  updateScrollHeight();
  renderVisibleRows();
}

elements.logContainer.addEventListener('scroll', handleScroll);
window.addEventListener('resize', handleResize);

elements.severityFilter.addEventListener('change', applyFilters);

elements.searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    applyFilters();
  }, 300);
});

// Init
fetchStats();
handleResize();
applyFilters();