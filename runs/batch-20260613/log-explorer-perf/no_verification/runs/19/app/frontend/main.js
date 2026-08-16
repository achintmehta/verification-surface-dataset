const ROW_HEIGHT = 36;
const OVERSCAN = 20;
const LIMIT = 100;

let totalRows = 0;
let absoluteTotal = 0;
let currentSeverity = '';
let currentQuery = '';
let loadedData = new Map(); // offset -> row data
let pendingRequests = new Map(); // offset -> promise
let abortController = new AbortController();

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDiv = document.getElementById('stats');

async function fetchStats() {
  try {
    const res = await fetch('http://localhost:3000/api/stats');
    const data = await res.json();
    absoluteTotal = data.total;
    updateStats();
  } catch (err) {
    console.error(err);
  }
}

async function fetchLogs(offset) {
  if (loadedData.has(offset)) return;
  if (pendingRequests.has(offset)) return pendingRequests.get(offset);

  const url = new URL('http://localhost:3000/api/logs');
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', LIMIT);
  if (currentSeverity) url.searchParams.set('severity', currentSeverity);
  if (currentQuery) url.searchParams.set('q', currentQuery);

  const promise = fetch(url, { signal: abortController.signal })
    .then(res => res.json())
    .then(data => {
      totalRows = data.total;
      spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
      
      for (let i = 0; i < data.rows.length; i++) {
        loadedData.set(offset + i, data.rows[i]);
      }
      pendingRequests.delete(offset);
      renderViewport();
      updateStats();
    })
    .catch(err => {
      if (err.name !== 'AbortError') {
        console.error(err);
      }
      pendingRequests.delete(offset);
    });

  pendingRequests.set(offset, promise);
  return promise;
}

function updateStats() {
  if (absoluteTotal > 0) {
    statsDiv.textContent = `${totalRows} of ${absoluteTotal} rows`;
  } else {
    statsDiv.textContent = `${totalRows} rows`;
  }
}

function renderViewport() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;

  if (totalRows === 0) {
    rowsContainer.innerHTML = '<div style="padding: 16px;">No logs found.</div>';
    rowsContainer.style.transform = `translateY(0px)`;
    return;
  }

  const startIdx = Math.floor(scrollTop / ROW_HEIGHT);
  const endIdx = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const renderStart = Math.max(0, startIdx - OVERSCAN);
  const renderEnd = Math.min(totalRows - 1, endIdx + OVERSCAN);

  // Fetch missing chunks
  const startChunk = Math.floor(renderStart / LIMIT) * LIMIT;
  const endChunk = Math.floor(renderEnd / LIMIT) * LIMIT;

  for (let chunk = startChunk; chunk <= endChunk; chunk += LIMIT) {
    fetchLogs(chunk);
  }

  rowsContainer.innerHTML = '';
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;

  const fragment = document.createDocumentFragment();

  for (let i = renderStart; i <= renderEnd; i++) {
    const rowData = loadedData.get(i);
    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';

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

function resetAndFetch() {
  abortController.abort();
  abortController = new AbortController();
  loadedData.clear();
  pendingRequests.clear();
  totalRows = 0;
  spacer.style.height = '0px';
  viewport.scrollTop = 0;
  
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
  requestAnimationFrame(renderViewport);
});

// Initial load
fetchStats();
resetAndFetch();
