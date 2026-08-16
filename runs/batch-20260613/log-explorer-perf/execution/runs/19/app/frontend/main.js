const API_URL = 'http://localhost:3001/api';

const ROW_HEIGHT = 40;
const WINDOW_SIZE = 100;
const OVERSCAN = 20;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let rowCache = new Map();
let pendingRequests = new Map();
let currentRequestId = 0;

const viewport = document.getElementById('viewport');
const scrollContent = document.getElementById('scroll-content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let stats = { total: 0, counts: {} };

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    stats = await res.json();
    updateSeverityOptions();
    if (totalRows > 0 || currentSeverity || currentQuery) {
      rowCountEl.textContent = `${totalRows} of ${stats.total}`;
    }
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

function updateSeverityOptions() {
  const options = severityFilter.options;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (opt.value === '') {
      opt.text = `All Severities (${stats.total})`;
    } else {
      opt.text = `${opt.value.charAt(0).toUpperCase() + opt.value.slice(1)} (${stats.counts[opt.value] || 0})`;
    }
  }
}

async function fetchWindow(windowIndex, requestId) {
  if (rowCache.has(windowIndex) || pendingRequests.has(windowIndex)) {
    return;
  }

  const offset = windowIndex * WINDOW_SIZE;
  const url = new URL(`${API_URL}/logs`);
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', WINDOW_SIZE);
  if (currentSeverity) url.searchParams.set('severity', currentSeverity);
  if (currentQuery) url.searchParams.set('q', currentQuery);

  const controller = new AbortController();
  pendingRequests.set(windowIndex, controller);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const data = await res.json();
    
    if (requestId !== currentRequestId) return; // Stale request

    totalRows = data.total;
    scrollContent.style.height = `${totalRows * ROW_HEIGHT}px`;
    rowCountEl.textContent = `${totalRows} of ${stats.total || '...'}`;

    rowCache.set(windowIndex, data.rows);
    pendingRequests.delete(windowIndex);
    
    render();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Failed to fetch window', e);
      pendingRequests.delete(windowIndex);
    }
  }
}

const rowPool = [];

function getRowElement(index) {
  if (index < rowPool.length) {
    return rowPool[index];
  }
  const el = document.createElement('div');
  el.className = 'log-row';
  
  const tsEl = document.createElement('div');
  tsEl.className = 'col-ts';
  
  const sevEl = document.createElement('div');
  sevEl.className = 'col-severity';
  
  const srvEl = document.createElement('div');
  srvEl.className = 'col-service';
  
  const msgEl = document.createElement('div');
  msgEl.className = 'col-message';
  
  el.appendChild(tsEl);
  el.appendChild(sevEl);
  el.appendChild(srvEl);
  el.appendChild(msgEl);
  
  scrollContent.appendChild(el);
  rowPool.push({ el, tsEl, sevEl, srvEl, msgEl });
  return rowPool[index];
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  if (viewportHeight === 0) return; // Not visible yet

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  const neededWindows = new Set();
  for (let i = startIndex; i <= endIndex; i++) {
    neededWindows.add(Math.floor(i / WINDOW_SIZE));
  }

  for (const win of neededWindows) {
    fetchWindow(win, currentRequestId);
  }

  let poolIndex = 0;
  
  for (let i = startIndex; i <= endIndex; i++) {
    const windowIndex = Math.floor(i / WINDOW_SIZE);
    const rowIndexInWindow = i % WINDOW_SIZE;
    
    const windowData = rowCache.get(windowIndex);
    const rowObj = getRowElement(poolIndex++);
    const { el, tsEl, sevEl, srvEl, msgEl } = rowObj;
    
    el.style.top = `${i * ROW_HEIGHT}px`;
    el.style.display = 'flex';
    
    if (windowData && windowData[rowIndexInWindow]) {
      const row = windowData[rowIndexInWindow];
      const ts = new Date(row.ts).toISOString().replace('T', ' ').substring(0, 19);
      
      tsEl.textContent = ts;
      sevEl.textContent = row.severity;
      sevEl.className = `col-severity sev-${row.severity}`;
      srvEl.textContent = row.service;
      msgEl.textContent = row.message;
      msgEl.title = row.message;
    } else {
      tsEl.textContent = 'Loading...';
      sevEl.textContent = '';
      sevEl.className = 'col-severity';
      srvEl.textContent = '';
      msgEl.textContent = '';
      msgEl.title = '';
    }
  }
  
  // Hide unused elements in the pool
  for (let i = poolIndex; i < rowPool.length; i++) {
    rowPool[i].el.style.display = 'none';
  }
}

function resetAndFetch() {
  currentRequestId++;
  
  // Abort pending requests
  for (const controller of pendingRequests.values()) {
    controller.abort();
  }
  pendingRequests.clear();
  rowCache.clear();
  
  totalRows = 0;
  scrollContent.style.height = '0px';
  rowCountEl.textContent = 'Loading...';
  viewport.scrollTop = 0;
  
  // Fetch first window to get total
  fetchWindow(0, currentRequestId);
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

window.addEventListener('resize', () => {
  requestAnimationFrame(render);
});

// Init
fetchStats();
resetAndFetch();
