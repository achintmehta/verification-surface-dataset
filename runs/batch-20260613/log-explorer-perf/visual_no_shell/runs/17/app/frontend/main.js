const API_URL = 'http://localhost:3000/api';

const ROW_HEIGHT = 40;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let logsCache = new Map(); // offset -> rows
let filterAbortController = null;
let chunkAbortControllers = new Map(); // offset -> AbortController

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const totalCountEl = document.getElementById('total-count');

async function fetchLogs(offset, severity, q, isFilterChange = false) {
  if (isFilterChange) {
    if (filterAbortController) {
      filterAbortController.abort();
    }
    filterAbortController = new AbortController();
    // Also abort all chunk fetches
    for (const controller of chunkAbortControllers.values()) {
      controller.abort();
    }
    chunkAbortControllers.clear();
  }
  
  const controller = new AbortController();
  chunkAbortControllers.set(offset, controller);
  
  const params = new URLSearchParams({
    offset,
    limit: LIMIT,
  });
  if (severity) params.append('severity', severity);
  if (q) params.append('q', q);
  
  try {
    const res = await fetch(`${API_URL}/logs?${params.toString()}`, {
      signal: controller.signal
    });
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    chunkAbortControllers.delete(offset);
    return data;
  } catch (err) {
    chunkAbortControllers.delete(offset);
    if (err.name === 'AbortError') {
      return null;
    }
    console.error(err);
    return null;
  }
}

let globalTotal = 0;

async function updateStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    globalTotal = data.total;
    
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (opt.value === '') {
        opt.textContent = `All Severities (${data.total})`;
      } else if (data.counts[opt.value] !== undefined) {
        const label = opt.value.charAt(0).toUpperCase() + opt.value.slice(1);
        opt.textContent = `${label} (${data.counts[opt.value]})`;
      }
    }
    
    if (totalRows > 0) {
      totalCountEl.textContent = `${totalRows} of ${globalTotal} rows`;
    }
  } catch (err) {
    console.error(err);
  }
}

async function reloadData() {
  logsCache.clear();
  logsCache.set(0, []); // placeholder
  viewport.scrollTop = 0;
  const data = await fetchLogs(0, currentSeverity, currentQuery, true);
  if (!data) return; // Aborted or error
  
  totalRows = data.total;
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
  totalCountEl.textContent = `${totalRows} of ${globalTotal || '...'} rows`;
  
  logsCache.set(0, data.rows);
  renderViewport();
}

function renderViewport() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  
  let renderStart = Math.max(0, startRow - OVERSCAN);
  let renderEnd = Math.min(totalRows, endRow + OVERSCAN);
  
  const chunkOffset = Math.floor(renderStart / LIMIT) * LIMIT;
  
  if (!logsCache.has(chunkOffset)) {
    logsCache.set(chunkOffset, []); // placeholder
    fetchLogs(chunkOffset, currentSeverity, currentQuery).then(data => {
      if (data) {
        totalRows = data.total;
        spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
        totalCountEl.textContent = `${totalRows} of ${globalTotal || '...'} rows`;
        logsCache.set(chunkOffset, data.rows);
        renderViewport();
      }
    });
  }
  
  const nextChunkOffset = chunkOffset + LIMIT;
  if (renderEnd > nextChunkOffset && !logsCache.has(nextChunkOffset) && nextChunkOffset < totalRows) {
    logsCache.set(nextChunkOffset, []);
    fetchLogs(nextChunkOffset, currentSeverity, currentQuery).then(data => {
      if (data) {
        logsCache.set(nextChunkOffset, data.rows);
        renderViewport();
      }
    });
  }
  
  rowsContainer.innerHTML = '';
  rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  
  const fragment = document.createDocumentFragment();
  
  for (let i = renderStart; i < renderEnd; i++) {
    const chunk = Math.floor(i / LIMIT) * LIMIT;
    const rows = logsCache.get(chunk);
    const rowData = rows ? rows[i - chunk] : null;
    
    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';
    
    if (rowData) {
      const escapeHTML = (str) => str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
      }[tag]));
      rowEl.innerHTML = `
        <div class="col-ts">${new Date(rowData.ts).toLocaleString()}</div>
        <div class="col-sev sev-${rowData.severity}">${rowData.severity}</div>
        <div class="col-svc">${escapeHTML(rowData.service)}</div>
        <div class="col-msg" title="${escapeHTML(rowData.message)}">${escapeHTML(rowData.message)}</div>
      `;
    } else {
      rowEl.innerHTML = `<div class="col-msg">Loading...</div>`;
    }
    
    fragment.appendChild(rowEl);
  }
  
  rowsContainer.appendChild(fragment);
}

let scrollTimeout;
viewport.addEventListener('scroll', () => {
  if (scrollTimeout) cancelAnimationFrame(scrollTimeout);
  scrollTimeout = requestAnimationFrame(() => {
    renderViewport();
  });
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  reloadData();
});

let debounceTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    currentQuery = e.target.value;
    reloadData();
  }, 300);
});

// Initial load
reloadData();
updateStats();