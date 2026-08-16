const ROW_HEIGHT = 30;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let loadedData = new Map(); // offset -> row data
let fetchController = null;
let pendingFetch = null;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDisplay = document.getElementById('stats-display');

const rowPool = [];

function getRowElement(index) {
  if (index < rowPool.length) {
    return rowPool[index];
  }
  const rowEl = document.createElement('div');
  rowEl.className = 'row';
  
  const tsEl = document.createElement('div');
  tsEl.className = 'ts';
  
  const sevEl = document.createElement('div');
  sevEl.className = 'severity';
  
  const srvEl = document.createElement('div');
  srvEl.className = 'service';
  
  const msgEl = document.createElement('div');
  msgEl.className = 'message';
  
  rowEl.appendChild(tsEl);
  rowEl.appendChild(sevEl);
  rowEl.appendChild(srvEl);
  rowEl.appendChild(msgEl);
  
  rowsContainer.appendChild(rowEl);
  rowPool.push({ rowEl, tsEl, sevEl, srvEl, msgEl });
  return rowPool[index];
}

let globalTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch('http://localhost:3001/api/stats');
    const stats = await res.json();
    globalTotal = stats.total;
  } catch (e) {
    console.error(e);
  }
}

async function fetchLogs(offset, limit, severity, q) {
  if (fetchController) {
    fetchController.abort();
  }
  fetchController = new AbortController();
  
  const params = new URLSearchParams({ offset, limit });
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  try {
    const res = await fetch(`http://localhost:3001/api/logs?${params.toString()}`, {
      signal: fetchController.signal
    });
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    return data;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

async function reloadData() {
  loadedData.clear();
  viewport.scrollTop = 0;
  await loadWindow(0);
}

async function loadWindow(startIndex) {
  pendingFetch = startIndex;
  const data = await fetchLogs(startIndex, LIMIT, currentSeverity, currentQuery);
  if (!data) return; // aborted
  if (pendingFetch === startIndex) pendingFetch = null;

  totalRows = data.total;
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
  statsDisplay.textContent = `${totalRows} of ${globalTotal}`;

  for (let i = 0; i < data.rows.length; i++) {
    loadedData.set(startIndex + i, data.rows[i]);
  }
  
  render();
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  let startIndex = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  let endIndex = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN;
  
  startIndex = Math.max(0, startIndex);
  endIndex = Math.min(Math.max(0, totalRows - 1), endIndex);
  
  // Check if we need to fetch more data
  let missingStart = -1;
  if (totalRows > 0) {
    for (let i = startIndex; i <= endIndex; i++) {
      if (!loadedData.has(i)) {
        missingStart = i;
        break;
      }
    }
  }

  if (missingStart !== -1) {
    const fetchStart = Math.max(0, Math.floor(missingStart / LIMIT) * LIMIT);
    if (pendingFetch !== fetchStart) {
      pendingFetch = fetchStart;
      fetchLogs(fetchStart, LIMIT, currentSeverity, currentQuery).then(data => {
        if (!data) return; // aborted
        if (pendingFetch === fetchStart) pendingFetch = null;
        totalRows = data.total;
        spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
        statsDisplay.textContent = `${totalRows} of ${globalTotal}`;
        for (let i = 0; i < data.rows.length; i++) {
          loadedData.set(fetchStart + i, data.rows[i]);
        }
        render();
      }).catch(e => {
        if (pendingFetch === fetchStart) pendingFetch = null;
        console.error(e);
      });
    }
  }

  let poolIndex = 0;
  if (totalRows > 0) {
    for (let i = startIndex; i <= endIndex; i++) {
      const rowData = loadedData.get(i);
      const els = getRowElement(poolIndex);
      els.rowEl.style.display = 'flex';
      els.rowEl.style.top = `${i * ROW_HEIGHT}px`;
      
      if (rowData) {
        els.tsEl.textContent = new Date(rowData.ts).toLocaleString();
        els.sevEl.className = `severity sev-${rowData.severity}`;
        els.sevEl.textContent = rowData.severity.toUpperCase();
        els.srvEl.textContent = rowData.service;
        els.msgEl.textContent = rowData.message;
      } else {
        els.tsEl.textContent = '';
        els.sevEl.className = 'severity';
        els.sevEl.textContent = '';
        els.srvEl.textContent = '';
        els.msgEl.textContent = 'Loading...';
      }
      poolIndex++;
    }
  }
  
  // Hide unused pool elements
  for (let i = poolIndex; i < rowPool.length; i++) {
    rowPool[i].rowEl.style.display = 'none';
  }
}

viewport.addEventListener('scroll', () => {
  requestAnimationFrame(render);
});

let debounceTimer;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = e.target.value;
    reloadData();
  }, 300);
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  reloadData();
});

// Initial load
fetchStats().then(() => {
  reloadData();
});
