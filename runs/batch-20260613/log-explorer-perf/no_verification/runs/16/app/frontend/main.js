const ROW_HEIGHT = 40;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let globalTotal = 0;
let currentSeverity = '';
let currentQuery = '';
let loadedData = new Map();
let inFlightRequests = new Map();
let latestFetchId = 0;

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
    globalTotal = data.total;
    updateStats();
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

async function fetchLogs(offset, fetchId) {
  if (loadedData.has(offset)) return;
  if (inFlightRequests.has(offset)) return;

  const controller = new AbortController();
  inFlightRequests.set(offset, controller);

  try {
    const params = new URLSearchParams({
      offset,
      limit: LIMIT,
    });
    if (currentSeverity) params.set('severity', currentSeverity);
    if (currentQuery) params.set('q', currentQuery);

    const res = await fetch(`http://localhost:3000/api/logs?${params.toString()}`, {
      signal: controller.signal
    });
    const data = await res.json();

    if (fetchId !== latestFetchId) return;

    totalRows = data.total;
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
    updateStats();

    data.rows.forEach((row, i) => {
      loadedData.set(offset + i, row);
    });

    renderViewport();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Failed to fetch logs', e);
    }
  } finally {
    inFlightRequests.delete(offset);
  }
}

function updateStats() {
  statsDiv.textContent = `${totalRows} of ${globalTotal}`;
}

function renderViewport() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;

  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const renderStart = Math.max(0, startRow - OVERSCAN);
  const renderEnd = Math.min(totalRows, endRow + OVERSCAN);

  const startBlock = Math.floor(renderStart / LIMIT) * LIMIT;
  const endBlock = Math.floor(renderEnd / LIMIT) * LIMIT;

  for (let offset = startBlock; offset <= endBlock; offset += LIMIT) {
    fetchLogs(offset, latestFetchId);
  }

  rowsContainer.innerHTML = '';
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;

  const fragment = document.createDocumentFragment();

  for (let i = renderStart; i < renderEnd; i++) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'log-row';
    
    const rowData = loadedData.get(i);
    if (rowData) {
      rowDiv.innerHTML = `
        <div class="col-ts">${rowData.ts.replace('T', ' ').substring(0, 19)}</div>
        <div class="col-sev sev-${rowData.severity}">${rowData.severity}</div>
        <div class="col-svc">${rowData.service}</div>
        <div class="col-msg" title="${escapeHtml(rowData.message)}">${escapeHtml(rowData.message)}</div>
      `;
    } else {
      rowDiv.innerHTML = `<div class="col-msg">Loading...</div>`;
    }
    fragment.appendChild(rowDiv);
  }

  rowsContainer.appendChild(fragment);
}

function escapeHtml(str) {
  if (!str) return '';
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

function resetAndFetch() {
  latestFetchId++;
  
  for (const controller of inFlightRequests.values()) {
    controller.abort();
  }
  inFlightRequests.clear();
  loadedData.clear();
  
  viewport.scrollTop = 0;
  totalRows = 0;
  spacer.style.height = '0px';
  rowsContainer.innerHTML = '';
  
  fetchLogs(0, latestFetchId);
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

fetchStats();
resetAndFetch();
