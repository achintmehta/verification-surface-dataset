const API_BASE = 'http://localhost:3000/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let overscan = 10;
let visibleRows = 20; // approx
let isLoading = false;
let lastRequestId = 0;

const scroller = document.getElementById('virtual-scroller');
const content = document.getElementById('virtual-content');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');

let rowsData = []; // currently rendered rows
let currentOffset = 0;

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    statsEl.innerHTML = `Total: ${data.total.toLocaleString()} | Debug: ${data.perSeverity.debug} | Info: ${data.perSeverity.info} | Warn: ${data.perSeverity.warn} | Error: ${data.perSeverity.error}`;
  } catch (e) {
    console.error(e);
  }
}

async function fetchLogs(offset, limit, severity, q) {
  const requestId = ++lastRequestId;
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);
  
  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Request failed');
  }
  const data = await res.json();
  
  // Ignore stale responses
  if (requestId !== lastRequestId) {
    return null;
  }
  
  return data;
}

function renderRows(rows, startOffset) {
  content.innerHTML = '';
  content.style.height = `${currentTotal * rowHeight}px`;
  
  rowsData = rows;
  currentOffset = startOffset;
  
  rows.forEach((row, idx) => {
    const el = document.createElement('div');
    el.className = `log-row sev-${row.severity}`;
    el.style.top = `${(startOffset + idx) * rowHeight}px`;
    
    const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
    el.innerHTML = `
      <div class="col-ts">${ts}</div>
      <div class="col-sev ${row.severity}">${row.severity.toUpperCase()}</div>
      <div class="col-svc">${row.service}</div>
      <div class="col-msg">${row.message}</div>
    `;
    content.appendChild(el);
  });
  
  updateRowCount();
}

function updateRowCount() {
  rowCountEl.textContent = `${rowsData.length} of ${currentTotal.toLocaleString()}`;
}

function updateVisibleWindow() {
  if (isLoading || currentTotal === 0) return;
  
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endRow = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  const neededLimit = Math.min(200, endRow - startRow);
  
  if (neededLimit <= 0) return;
  
  // Check if we need to fetch new window
  const needsFetch = rowsData.length === 0 || 
    startRow < currentOffset || 
    startRow + neededLimit > currentOffset + rowsData.length;
  
  if (needsFetch) {
    isLoading = true;
    const fetchOffset = startRow;
    
    fetchLogs(fetchOffset, neededLimit, currentFilter.severity, currentFilter.q)
      .then(data => {
        if (data) {
          currentTotal = data.total;
          content.style.height = `${currentTotal * rowHeight}px`;
          renderRows(data.rows, fetchOffset);
        }
      })
      .catch(err => console.error('Fetch error:', err))
      .finally(() => { isLoading = false; });
  } else {
    // Recycle: adjust existing if possible, but for simplicity re-render window
    // Since we fetch exact, just ensure visible
    const visibleStartIdx = Math.max(0, startRow - currentOffset);
    const visibleEndIdx = Math.min(rowsData.length, endRow - currentOffset);
    // For full correctness, we could slice but since small, re-fetch is fine and simple
  }
}

let scrollTimeout;
scroller.addEventListener('scroll', () => {
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    updateVisibleWindow();
  }, 50);
});

function resetAndLoad() {
  rowsData = [];
  currentOffset = 0;
  content.innerHTML = '';
  content.style.height = '0px';
  isLoading = false;
  lastRequestId++; // invalidate pending
  
  // Initial load at top
  isLoading = true;
  fetchLogs(0, 50, currentFilter.severity, currentFilter.q)
    .then(data => {
      if (data) {
        currentTotal = data.total;
        content.style.height = `${currentTotal * rowHeight}px`;
        renderRows(data.rows, 0);
        // Set initial scroll height etc.
      }
    })
    .catch(err => console.error(err))
    .finally(() => isLoading = false);
}

severitySelect.addEventListener('change', () => {
  currentFilter.severity = severitySelect.value;
  resetAndLoad();
});

const debouncedSearch = debounce(() => {
  currentFilter.q = searchInput.value.trim();
  resetAndLoad();
}, 300);

searchInput.addEventListener('input', debouncedSearch);

// Initial load
fetchStats();
resetAndLoad();

// Handle window resize
window.addEventListener('resize', () => {
  updateVisibleWindow();
});

// Keyboard support etc. not needed

console.log('Log Explorer initialized');