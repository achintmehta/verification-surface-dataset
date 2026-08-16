const ROW_HEIGHT = 30;
const OVERSCAN = 10;
const API_URL = 'http://localhost:3001/api';

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let cachedRows = new Map(); // offset -> row data
let pendingRequests = new Map(); // offset -> promise
let abortController = new AbortController();

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const statsEl = document.getElementById('stats');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let absoluteTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    absoluteTotal = data.total;
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (val && data.counts[val] !== undefined) {
        options[i].textContent = `${options[i].textContent.split(' (')[0]} (${data.counts[val]})`;
      }
    }
  } catch (err) {
    console.error(err);
  }
}

async function fetchLogs(offset, limit, signal) {
  const params = new URLSearchParams({ offset, limit });
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  const res = await fetch(`${API_URL}/logs?${params.toString()}`, { signal });
  if (!res.ok) throw new Error('Failed to fetch logs');
  return res.json();
}

function updateStats(total) {
  statsEl.textContent = `${total} of ${absoluteTotal} rows`;
}

function renderRow(row) {
  const el = document.createElement('div');
  el.className = 'log-row';
  
  const ts = document.createElement('div');
  ts.className = 'col-ts';
  ts.textContent = new Date(row.ts).toLocaleString();
  
  const sev = document.createElement('div');
  sev.className = `col-sev sev-${row.severity}`;
  sev.textContent = row.severity.toUpperCase();
  
  const svc = document.createElement('div');
  svc.className = 'col-svc';
  svc.textContent = row.service;
  
  const msg = document.createElement('div');
  msg.className = 'col-msg';
  msg.textContent = row.message;
  msg.title = row.message;
  
  el.appendChild(ts);
  el.appendChild(sev);
  el.appendChild(svc);
  el.appendChild(msg);
  
  return el;
}

let renderTimeout = null;
let lastScrollTop = 0;

async function onScroll() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  const startIdx = Math.floor(scrollTop / ROW_HEIGHT);
  const endIdx = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  
  const renderStart = Math.max(0, startIdx - OVERSCAN);
  const renderEnd = Math.min(totalRows, endIdx + OVERSCAN);
  
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  rowsContainer.innerHTML = '';
  
  const missingOffsets = [];
  
  for (let i = renderStart; i < renderEnd; i++) {
    if (cachedRows.has(i)) {
      rowsContainer.appendChild(renderRow(cachedRows.get(i)));
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'log-row';
      placeholder.textContent = 'Loading...';
      rowsContainer.appendChild(placeholder);
      missingOffsets.push(i);
    }
  }
  
  if (missingOffsets.length > 0) {
    const pagesToFetch = new Set();
    for (const offset of missingOffsets) {
      pagesToFetch.add(Math.floor(offset / 100) * 100);
    }
    
    for (const pageStart of pagesToFetch) {
      if (!pendingRequests.has(pageStart)) {
        const promise = fetchLogs(pageStart, 100, abortController.signal)
          .then(data => {
            totalRows = data.total;
            spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
            updateStats(totalRows);
            
            data.rows.forEach((row, idx) => {
              cachedRows.set(pageStart + idx, row);
            });
            
            pendingRequests.delete(pageStart);
            
            // Re-render if we are still looking at this chunk
            const currentStartIdx = Math.floor(viewport.scrollTop / ROW_HEIGHT);
            const currentEndIdx = Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT);
            const currentRenderStart = Math.max(0, currentStartIdx - OVERSCAN);
            const currentRenderEnd = Math.min(totalRows, currentEndIdx + OVERSCAN);
            
            if (pageStart + 100 > currentRenderStart && pageStart < currentRenderEnd) {
              onScroll();
            }
          })
          .catch(err => {
            if (err.name !== 'AbortError') {
              console.error(err);
            }
            pendingRequests.delete(pageStart);
          });
          
        pendingRequests.set(pageStart, promise);
      }
    }
  }
}

let debounceTimeout = null;

async function applyFilters() {
  abortController.abort();
  abortController = new AbortController();
  
  cachedRows.clear();
  pendingRequests.clear();
  
  viewport.scrollTop = 0;
  
  const promise = fetchLogs(0, 100, abortController.signal)
    .then(data => {
      totalRows = data.total;
      spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
      updateStats(totalRows);
      
      data.rows.forEach((row, idx) => {
        cachedRows.set(idx, row);
      });
      
      pendingRequests.delete(0);
      onScroll();
    })
    .catch(err => {
      if (err.name !== 'AbortError') {
        console.error(err);
      }
      pendingRequests.delete(0);
    });
    
  pendingRequests.set(0, promise);
}

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  applyFilters();
});

searchInput.addEventListener('input', (e) => {
  currentQuery = e.target.value;
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    applyFilters();
  }, 300);
});

viewport.addEventListener('scroll', () => {
  if (renderTimeout) cancelAnimationFrame(renderTimeout);
  renderTimeout = requestAnimationFrame(onScroll);
});

// Initial load
fetchStats().then(() => applyFilters());