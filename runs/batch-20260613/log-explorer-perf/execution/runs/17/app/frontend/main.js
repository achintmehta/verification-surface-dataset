const ROW_HEIGHT = 36;
const CHUNK_SIZE = 100;
const OVERSCAN = 20;

let totalRows = 0;
let currentSeverity = '';
let currentSearch = '';
let stats = { total: 0, counts: {} };

const container = document.getElementById('log-container');
const scrollContent = document.getElementById('log-scroll-content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsContainer = document.getElementById('stats-container');

let rowCache = new Map();
let pendingRequests = new Map();
let abortController = new AbortController();

async function fetchStats() {
  try {
    const res = await fetch('http://localhost:3000/api/stats');
    if (!res.ok) throw new Error('Network response was not ok');
    stats = await res.json();
    updateStatsUI();
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

function updateStatsUI() {
  let html = `<span>${totalRows} of ${stats.total} rows</span>`;
  if (stats.counts) {
    html += `
      <span class="badge debug">D: ${stats.counts.debug || 0}</span>
      <span class="badge info">I: ${stats.counts.info || 0}</span>
      <span class="badge warn">W: ${stats.counts.warn || 0}</span>
      <span class="badge error">E: ${stats.counts.error || 0}</span>
    `;
  }
  statsContainer.innerHTML = html;
}

async function fetchChunk(chunkIndex) {
  if (rowCache.has(chunkIndex)) return;
  if (pendingRequests.has(chunkIndex)) return;

  const offset = chunkIndex * CHUNK_SIZE;
  const url = new URL('http://localhost:3000/api/logs');
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', CHUNK_SIZE);
  if (currentSeverity) url.searchParams.set('severity', currentSeverity);
  if (currentSearch) url.searchParams.set('q', currentSearch);

  const promise = fetch(url.toString(), { signal: abortController.signal })
    .then(res => {
      if (!res.ok) throw new Error('Network response was not ok');
      return res.json();
    })
    .then(data => {
      totalRows = data.total;
      scrollContent.style.height = `${totalRows * ROW_HEIGHT}px`;
      updateStatsUI();
      
      const rows = data.rows;
      rowCache.set(chunkIndex, rows);
      pendingRequests.delete(chunkIndex);
      renderVisibleRows();
    })
    .catch(err => {
      if (err.name !== 'AbortError') {
        console.error('Fetch error', err);
      }
      pendingRequests.delete(chunkIndex);
    });

  pendingRequests.set(chunkIndex, promise);
}

function renderVisibleRows() {
  const scrollTop = container.scrollTop;
  const clientHeight = container.clientHeight;

  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN);

  const startChunk = Math.floor(startRow / CHUNK_SIZE);
  const endChunk = Math.floor(endRow / CHUNK_SIZE);

  for (let i = startChunk; i <= endChunk; i++) {
    fetchChunk(i);
  }

  // Render rows
  const fragment = document.createDocumentFragment();
  for (let i = startRow; i <= endRow; i++) {
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunk = rowCache.get(chunkIndex);
    const rowData = chunk ? chunk[i % CHUNK_SIZE] : null;

    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';
    rowEl.style.top = `${i * ROW_HEIGHT}px`;

    if (rowData) {
      rowEl.innerHTML = `
        <div class="col-ts">${new Date(rowData.ts).toLocaleString()}</div>
        <div class="col-severity sev-${rowData.severity}">${rowData.severity.toUpperCase()}</div>
        <div class="col-service">${rowData.service}</div>
        <div class="col-message">${escapeHtml(rowData.message)}</div>
      `;
    } else {
      rowEl.innerHTML = `<div class="col-message" style="color: #999;">Loading...</div>`;
    }
    fragment.appendChild(rowEl);
  }

  scrollContent.innerHTML = '';
  scrollContent.appendChild(fragment);
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function resetAndFetch() {
  abortController.abort();
  abortController = new AbortController();
  rowCache.clear();
  pendingRequests.clear();
  container.scrollTop = 0;
  totalRows = 0;
  scrollContent.style.height = '0px';
  scrollContent.innerHTML = '';
  
  // Fetch initial chunk to get total
  fetchChunk(0);
}

let debounceTimer;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentSearch = e.target.value.trim();
    resetAndFetch();
  }, 300);
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

container.addEventListener('scroll', () => {
  renderVisibleRows();
});

// Initial load
fetchStats();
resetAndFetch();
