const ROW_HEIGHT = 40;
const CHUNK_SIZE = 100;
const API_URL = '/api';

let currentTotal = 0;
let globalTotal = 0;
let currentFilters = { severity: '', q: '' };
let rowCache = new Map();
let pendingChunks = new Set();
let currentFetchId = 0;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const statsEl = document.getElementById('stats');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    globalTotal = data.total;
    
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (val && data.counts[val] !== undefined) {
        const label = val.charAt(0).toUpperCase() + val.slice(1);
        options[i].textContent = `${label} (${data.counts[val].toLocaleString()})`;
      }
    }
    
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

async function fetchChunk(chunkIndex, fetchId) {
  if (pendingChunks.has(chunkIndex)) return;
  pendingChunks.add(chunkIndex);

  const offset = chunkIndex * CHUNK_SIZE;
  const params = new URLSearchParams({
    offset,
    limit: CHUNK_SIZE
  });
  if (currentFilters.severity) params.set('severity', currentFilters.severity);
  if (currentFilters.q) params.set('q', currentFilters.q);

  try {
    const res = await fetch(`${API_URL}/logs?${params.toString()}`);
    const data = await res.json();

    if (fetchId !== currentFetchId) return; // Stale request

    isLoading = false;
    currentTotal = data.total;
    spacer.style.height = `${currentTotal * ROW_HEIGHT}px`;
    updateStats();

    data.rows.forEach((row, i) => {
      rowCache.set(offset + i, row);
    });

    renderVisibleRows();
  } catch (e) {
    console.error(e);
    if (fetchId === currentFetchId) {
      isLoading = false;
      rowsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: #cc0000;">Error loading logs</div>';
    }
  } finally {
    if (fetchId === currentFetchId) {
      pendingChunks.delete(chunkIndex);
    }
  }
}

function updateStats() {
  if (globalTotal > 0) {
    statsEl.textContent = `${currentTotal.toLocaleString()} of ${globalTotal.toLocaleString()} rows`;
  } else {
    statsEl.textContent = `${currentTotal.toLocaleString()} rows`;
  }
}

function renderVisibleRows() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight || 800;
  
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const endIndex = Math.min(currentTotal - 1, Math.floor((scrollTop + viewportHeight) / ROW_HEIGHT) + 5);

  if (currentTotal === 0) {
    if (!isLoading) {
      rowsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: #666;">No logs found</div>';
      rowsContainer.style.transform = `translateY(0px)`;
    }
    return;
  }

  const startChunk = Math.floor(startIndex / CHUNK_SIZE);
  const endChunk = Math.floor(endIndex / CHUNK_SIZE);

  for (let c = startChunk; c <= endChunk; c++) {
    if (!rowCache.has(c * CHUNK_SIZE) && c * CHUNK_SIZE < currentTotal) {
      fetchChunk(c, currentFetchId);
    }
  }

  let html = '';
  for (let i = startIndex; i <= endIndex; i++) {
    const row = rowCache.get(i);
    if (row) {
      const d = new Date(row.ts);
      const tsStr = d.toISOString().replace('T', ' ').substring(0, 19);
      html += `
        <div class="log-row" style="height: ${ROW_HEIGHT}px;">
          <div class="col-ts">${tsStr}</div>
          <div class="col-sev sev-${row.severity}">${row.severity.toUpperCase()}</div>
          <div class="col-svc">${row.service}</div>
          <div class="col-msg" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
        </div>
      `;
    } else {
      html += `<div class="log-row" style="height: ${ROW_HEIGHT}px;"><div style="padding: 0 16px; color: #999;">Loading...</div></div>`;
    }
  }

  rowsContainer.innerHTML = html;
  rowsContainer.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

let isLoading = false;

function resetAndFetch() {
  currentFetchId++;
  rowCache.clear();
  pendingChunks.clear();
  viewport.scrollTop = 0;
  currentTotal = 0;
  isLoading = true;
  spacer.style.height = '0px';
  rowsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: #666;">Loading...</div>';
  rowsContainer.style.transform = `translateY(0px)`;
  
  // Fetch first chunk to get total and initial rows
  fetchChunk(0, currentFetchId);
}

viewport.addEventListener('scroll', () => {
  renderVisibleRows();
});

severityFilter.addEventListener('change', (e) => {
  currentFilters.severity = e.target.value;
  resetAndFetch();
});

let searchTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentFilters.q = e.target.value;
    resetAndFetch();
  }, 300);
});

// Initial load
fetchStats();
resetAndFetch();
