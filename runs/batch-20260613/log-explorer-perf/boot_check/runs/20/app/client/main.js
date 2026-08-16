const API_URL = 'http://localhost:3000/api';

const ROW_HEIGHT = 36;
const LIMIT = 100;
const OVERSCAN = 20;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let loadedOffset = -1;
let loadedRows = [];
let isFetching = false;
let fetchAbortController = null;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const totalCountEl = document.getElementById('total-count');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

async function fetchLogs(offset) {
  if (fetchAbortController) {
    fetchAbortController.abort();
  }
  const controller = new AbortController();
  fetchAbortController = controller;

  const params = new URLSearchParams({
    offset,
    limit: LIMIT
  });
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  try {
    isFetching = true;
    const res = await fetch(`${API_URL}/logs?${params.toString()}`, {
      signal: controller.signal
    });
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    
    totalRows = data.total;
    loadedOffset = offset;
    loadedRows = data.rows;
    
    updateSpacer();
    updateStats();
    renderRows();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch error:', err);
    }
  } finally {
    if (fetchAbortController === controller) {
      isFetching = false;
    }
  }
}

function updateSpacer() {
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

let globalTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    globalTotal = data.total;
    
    // Update severity dropdown with counts
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (val && data.counts[val] !== undefined) {
        options[i].textContent = `${val.charAt(0).toUpperCase() + val.slice(1)} (${data.counts[val]})`;
      }
    }
    updateStats();
  } catch (err) {
    console.error('Stats fetch error:', err);
  }
}

function updateStats() {
  if (globalTotal > 0) {
    totalCountEl.textContent = `${totalRows} of ${globalTotal} rows`;
  } else {
    totalCountEl.textContent = `${totalRows} rows`;
  }
}

function renderRows() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  
  // Check if we need to fetch
  // Only fetch if the required rows are within the totalRows bounds
  const requiredStart = Math.max(0, startRow);
  const requiredEnd = Math.min(totalRows, endRow);
  
  const needsFetch = requiredStart < loadedOffset || requiredEnd > loadedOffset + loadedRows.length;
  
  if (needsFetch && !isFetching && totalRows > 0) {
    const fetchOffset = Math.max(0, startRow - OVERSCAN);
    fetchLogs(fetchOffset);
  }

  // Render from loadedRows
  rowsContainer.innerHTML = '';
  
  const renderStart = Math.max(startRow, loadedOffset);
  const renderEnd = Math.min(endRow, loadedOffset + loadedRows.length);
  
  if (renderStart >= renderEnd || loadedOffset === -1) {
    // No rows to show currently
    return;
  }
  
  const fragment = document.createDocumentFragment();
  
  for (let i = renderStart; i < renderEnd; i++) {
    const rowIndex = i - loadedOffset;
    const row = loadedRows[rowIndex];
    
    if (!row) continue;
    
    const div = document.createElement('div');
    div.className = 'log-row';
    
    const ts = document.createElement('div');
    ts.className = 'col-ts';
    ts.textContent = new Date(row.ts).toLocaleString();
    
    const sev = document.createElement('div');
    sev.className = `col-sev sev-${row.severity}`;
    sev.textContent = row.severity.toUpperCase();
    
    const svc = document.createElement('div');
    svc.className = 'col-svc';
    svc.textContent = row.service;
    
    const msg = document.createElement('div');
    msg.className = 'col-msg';
    msg.textContent = row.message;
    
    div.appendChild(ts);
    div.appendChild(sev);
    div.appendChild(svc);
    div.appendChild(msg);
    
    fragment.appendChild(div);
  }
  
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  rowsContainer.appendChild(fragment);
}

viewport.addEventListener('scroll', () => {
  renderRows();
});

let debounceTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    currentQuery = e.target.value;
    loadedOffset = -1;
    fetchLogs(0);
    viewport.scrollTop = 0;
  }, 300);
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  loadedOffset = -1;
  fetchLogs(0);
  viewport.scrollTop = 0;
});

// Initial fetch
fetchStats();
fetchLogs(0);
