const ROW_HEIGHT = 36;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let currentOffset = 0;
let logsCache = new Map();
let activeRequest = null;
let currentRequestId = 0;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsEl = document.getElementById('stats');

let filterSeverity = '';
let filterQuery = '';

let globalTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    globalTotal = data.total;
    updateStatsDisplay();
  } catch (e) {
    console.error(e);
  }
}

function updateStatsDisplay() {
  if (globalTotal > 0) {
    statsEl.textContent = `${totalRows} of ${globalTotal} rows`;
  } else {
    statsEl.textContent = `${totalRows} rows`;
  }
}

async function fetchLogs(offset, reqId) {
  const url = new URL('/api/logs', window.location.origin);
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', LIMIT);
  if (filterSeverity) url.searchParams.set('severity', filterSeverity);
  if (filterQuery) url.searchParams.set('q', filterQuery);

  try {
    const res = await fetch(url);
    const data = await res.json();
    
    if (reqId !== currentRequestId) return; // Stale request
    
    totalRows = data.total;
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
    
    updateStatsDisplay();
    
    // Cache the rows
    for (let i = 0; i < data.rows.length; i++) {
      logsCache.set(offset + i, data.rows[i]);
    }
    
    renderVisibleRows();
  } catch (e) {
    console.error(e);
  }
}

function renderVisibleRows() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  
  const renderStart = Math.max(0, startRow - OVERSCAN);
  const renderEnd = Math.min(totalRows - 1, endRow + OVERSCAN);
  
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  
  let html = '';
  let missingStart = -1;
  
  for (let i = renderStart; i <= renderEnd; i++) {
    const row = logsCache.get(i);
    if (row) {
      const d = new Date(row.ts);
      const tsStr = d.toISOString().replace('T', ' ').substring(0, 19);
      html += `
        <div class="log-row">
          <div class="col-ts">${tsStr}</div>
          <div class="col-sev sev-${row.severity}">${row.severity.toUpperCase()}</div>
          <div class="col-svc">${row.service}</div>
          <div class="col-msg" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
        </div>
      `;
    } else {
      html += `<div class="log-row">Loading...</div>`;
      if (missingStart === -1) missingStart = i;
    }
  }
  
  rowsContainer.innerHTML = html;
  
  if (missingStart !== -1) {
    // Need to fetch
    // Align offset to LIMIT boundaries
    const fetchOffset = Math.floor(missingStart / LIMIT) * LIMIT;
    if (activeRequest !== fetchOffset) {
      activeRequest = fetchOffset;
      fetchLogs(fetchOffset, currentRequestId);
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

viewport.addEventListener('scroll', () => {
  renderVisibleRows();
});

function resetAndFetch() {
  currentRequestId++;
  logsCache.clear();
  totalRows = 0;
  spacer.style.height = '0px';
  rowsContainer.innerHTML = '';
  viewport.scrollTop = 0;
  activeRequest = 0;
  fetchLogs(0, currentRequestId);
}

severityFilter.addEventListener('change', (e) => {
  filterSeverity = e.target.value;
  resetAndFetch();
});

let debounceTimer;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    filterQuery = e.target.value;
    resetAndFetch();
  }, 300);
});

// Initial fetch
fetchStats();
resetAndFetch();
