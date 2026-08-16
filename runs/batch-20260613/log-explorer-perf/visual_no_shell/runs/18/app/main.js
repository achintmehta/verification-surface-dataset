const ROW_HEIGHT = 37; // 36px + 1px border
const CHUNK_SIZE = 100;
const OVERSCAN = 20;

let totalRows = -1;
let currentFilters = { severity: '', q: '' };
let rowCache = new Map();
let pendingFetches = new Set();
let currentRequestId = 0;
let globalStats = { total: 0, counts: {} };

const viewport = document.getElementById('viewport');
const scrollContent = document.getElementById('scroll-content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsEl = document.getElementById('stats');

async function init() {
  await fetchStats();
  
  viewport.addEventListener('scroll', onScroll);
  window.addEventListener('resize', renderVisibleRows);
  severityFilter.addEventListener('change', onFilterChange);
  
  let debounceTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(onFilterChange, 300);
  });

  // Initial fetch
  resetAndFetch();
}

async function fetchStats() {
  try {
    const res = await fetch('http://localhost:3000/api/stats');
    globalStats = await res.json();
    updateStatsUI();
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

function updateStatsUI() {
  if (totalRows === -1) {
    statsEl.textContent = `Loading...`;
    return;
  }
  statsEl.textContent = `${totalRows} of ${globalStats.total} rows`;
}

function onFilterChange() {
  currentFilters = {
    severity: severityFilter.value,
    q: searchInput.value.trim()
  };
  resetAndFetch();
}

function resetAndFetch() {
  currentRequestId++;
  rowCache.clear();
  pendingFetches.clear();
  totalRows = -1;
  viewport.scrollTop = 0;
  scrollContent.innerHTML = '';
  scrollContent.style.height = '0px';
  updateStatsUI();
  
  ensureRows(0, CHUNK_SIZE);
}

async function fetchRows(offset, limit, reqId) {
  const params = new URLSearchParams({ offset, limit });
  if (currentFilters.severity) params.set('severity', currentFilters.severity);
  if (currentFilters.q) params.set('q', currentFilters.q);
  
  try {
    const res = await fetch(`http://localhost:3000/api/logs?${params.toString()}`);
    const data = await res.json();
    
    if (reqId === currentRequestId) {
      if (totalRows !== data.total) {
        totalRows = data.total;
        scrollContent.style.height = `${totalRows * ROW_HEIGHT}px`;
        updateStatsUI();
      }
      
      for (let i = 0; i < data.rows.length; i++) {
        rowCache.set(offset + i, data.rows[i]);
      }
      renderVisibleRows();
    }
  } catch (err) {
    console.error('Failed to fetch rows', err);
  }
}

function ensureRows(startIndex, endIndex) {
  const chunkStart = Math.floor(startIndex / CHUNK_SIZE) * CHUNK_SIZE;
  const chunkEnd = Math.ceil(endIndex / CHUNK_SIZE) * CHUNK_SIZE;
  
  for (let offset = chunkStart; offset < chunkEnd; offset += CHUNK_SIZE) {
    if (totalRows !== -1 && offset >= totalRows) continue;
    
    if (!pendingFetches.has(offset)) {
      let hasAll = true;
      const limit = totalRows !== -1 ? Math.min(CHUNK_SIZE, totalRows - offset) : CHUNK_SIZE;
      
      for (let i = 0; i < limit; i++) {
        if (!rowCache.has(offset + i)) {
          hasAll = false;
          break;
        }
      }
      
      if (!hasAll) {
        pendingFetches.add(offset);
        const reqId = currentRequestId;
        fetchRows(offset, CHUNK_SIZE, reqId).finally(() => {
          if (reqId === currentRequestId) {
            pendingFetches.delete(offset);
          }
        });
      }
    }
  }
}

function onScroll() {
  renderVisibleRows();
}

function renderVisibleRows() {
  if (totalRows === 0) {
    scrollContent.innerHTML = '<div style="padding: 1rem; text-align: center;">No logs found.</div>';
    return;
  }

  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  let startIndex = Math.floor(scrollTop / ROW_HEIGHT);
  let visibleRowsCount = Math.ceil(viewportHeight / ROW_HEIGHT);
  
  startIndex = Math.max(0, startIndex - OVERSCAN);
  let endIndex = startIndex + visibleRowsCount + (OVERSCAN * 2);
  
  if (totalRows !== -1) {
    endIndex = Math.min(endIndex, totalRows);
  }

  ensureRows(startIndex, endIndex);

  // Create a document fragment to minimize DOM updates
  const fragment = document.createDocumentFragment();
  
  for (let i = startIndex; i < endIndex; i++) {
    const row = rowCache.get(i);
    if (row) {
      const rowEl = document.createElement('div');
      rowEl.className = 'log-row';
      rowEl.style.top = `${i * ROW_HEIGHT}px`;
      
      const tsEl = document.createElement('div');
      tsEl.className = 'col-ts';
      tsEl.textContent = new Date(row.ts).toLocaleString();
      
      const sevEl = document.createElement('div');
      sevEl.className = `col-sev sev-${row.severity}`;
      sevEl.textContent = row.severity.toUpperCase();
      
      const svcEl = document.createElement('div');
      svcEl.className = 'col-svc';
      svcEl.textContent = row.service;
      
      const msgEl = document.createElement('div');
      msgEl.className = 'col-msg';
      msgEl.textContent = row.message;
      msgEl.title = row.message;
      
      rowEl.appendChild(tsEl);
      rowEl.appendChild(sevEl);
      rowEl.appendChild(svcEl);
      rowEl.appendChild(msgEl);
      
      fragment.appendChild(rowEl);
    } else {
      // Placeholder for loading row
      const rowEl = document.createElement('div');
      rowEl.className = 'log-row';
      rowEl.style.top = `${i * ROW_HEIGHT}px`;
      rowEl.textContent = 'Loading...';
      fragment.appendChild(rowEl);
    }
  }
  
  scrollContent.innerHTML = '';
  scrollContent.appendChild(fragment);
}

init();
