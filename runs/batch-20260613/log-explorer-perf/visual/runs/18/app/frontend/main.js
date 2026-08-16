const ROW_HEIGHT = 36;
const LIMIT = 100;
const OVERSCAN = 20;

let totalRows = 0;
let absoluteTotal = 0;
let currentSeverity = '';
let currentQuery = '';
let rowCache = new Map();
let pendingRequests = new Map();
let abortController = new AbortController();

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const content = document.getElementById('content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let fetchedChunks = new Set();

async function fetchStats() {
  try {
    const res = await fetch('http://localhost:3000/api/stats');
    const data = await res.json();
    absoluteTotal = data.total;
    
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (val && data.counts[val] !== undefined) {
        options[i].textContent = `${options[i].textContent.split(' (')[0]} (${data.counts[val]})`;
      }
    }
    updateStats();
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

async function fetchLogs(offset) {
  if (fetchedChunks.has(offset)) return;
  if (pendingRequests.has(offset)) return;

  const url = new URL('http://localhost:3000/api/logs');
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', LIMIT);
  if (currentSeverity) url.searchParams.set('severity', currentSeverity);
  if (currentQuery) url.searchParams.set('q', currentQuery);

  const promise = fetch(url, { signal: abortController.signal })
    .then(res => res.json())
    .then(data => {
      totalRows = data.total;
      updateStats();
      spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
      
      for (let i = 0; i < data.rows.length; i++) {
        rowCache.set(offset + i, data.rows[i]);
      }
      fetchedChunks.add(offset);
      pendingRequests.delete(offset);
      render();
    })
    .catch(err => {
      if (err.name !== 'AbortError') {
        console.error('Fetch error:', err);
      }
      pendingRequests.delete(offset);
    });

  pendingRequests.set(offset, promise);
}

function updateStats() {
  if (absoluteTotal > 0) {
    rowCountEl.textContent = `${totalRows} of ${absoluteTotal} rows`;
  } else {
    rowCountEl.textContent = `${totalRows} rows`;
  }
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;

  let startIdx = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  let endIdx = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN;

  startIdx = Math.max(0, startIdx);
  endIdx = Math.min(totalRows - 1, endIdx);

  // Determine which chunks we need
  const startChunk = Math.floor(startIdx / LIMIT) * LIMIT;
  const endChunk = Math.floor(endIdx / LIMIT) * LIMIT;

  for (let offset = startChunk; offset <= endChunk; offset += LIMIT) {
    fetchLogs(offset);
  }

  // Render visible rows
  content.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (let i = startIdx; i <= endIdx; i++) {
    const rowData = rowCache.get(i);
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    rowEl.style.position = 'absolute';
    rowEl.style.top = `${i * ROW_HEIGHT}px`;
    rowEl.style.left = '0';
    rowEl.style.right = '0';

    if (rowData) {
      rowEl.innerHTML = `
        <div class="col-ts">${new Date(rowData.ts).toLocaleString()}</div>
        <div class="col-sev sev-${rowData.severity}">${rowData.severity}</div>
        <div class="col-svc">${rowData.service}</div>
        <div class="col-msg" title="${rowData.message}">${rowData.message}</div>
      `;
    } else {
      rowEl.innerHTML = `<div style="padding: 0 16px; color: #999;">Loading...</div>`;
    }
    fragment.appendChild(rowEl);
  }

  content.appendChild(fragment);
}

function resetAndFetch() {
  abortController.abort();
  abortController = new AbortController();
  rowCache.clear();
  fetchedChunks.clear();
  pendingRequests.clear();
  totalRows = 0;
  viewport.scrollTop = 0;
  
  // Initial fetch to get total
  fetchLogs(0);
}

let debounceTimer;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = e.target.value.trim();
    resetAndFetch();
  }, 300);
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

viewport.addEventListener('scroll', () => {
  requestAnimationFrame(render);
});

// Initial load
fetchStats();
resetAndFetch();
