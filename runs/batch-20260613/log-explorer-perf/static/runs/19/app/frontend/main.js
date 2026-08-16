const ROW_HEIGHT = 30;
const OVERSCAN = 10;
const API_URL = 'http://localhost:3000/api';

let totalRows = 0;
let corpusTotal = 0;
let currentSeverity = '';
let currentQuery = '';
let loadedData = new Map(); // offset -> row data
let pendingRequests = new Map(); // offset -> abort controller

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountDisplay = document.getElementById('row-count');

let debounceTimer = null;

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const stats = await res.json();
    corpusTotal = stats.total;
    if (totalRows > 0) {
      rowCountDisplay.textContent = `${totalRows} of ${corpusTotal} rows`;
    }
  } catch (e) {
    console.error(e);
  }
}

async function fetchLogs(offset, limit, signal) {
  const params = new URLSearchParams({ offset, limit });
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);
  
  const res = await fetch(`${API_URL}/logs?${params.toString()}`, { signal });
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
}

function updateRowCount(total) {
  totalRows = total;
  spacer.style.height = `${total * ROW_HEIGHT}px`;
  if (corpusTotal > 0) {
    rowCountDisplay.textContent = `${total} of ${corpusTotal} rows`;
  } else {
    rowCountDisplay.textContent = `${total} rows`;
  }
}

function renderRows(startIndex, endIndex) {
  rowsContainer.innerHTML = '';
  rowsContainer.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
  
  for (let i = startIndex; i <= endIndex; i++) {
    if (i >= totalRows) break;
    
    const rowEl = document.createElement('div');
    rowEl.className = 'log-row';
    rowEl.style.height = `${ROW_HEIGHT}px`;
    
    const data = loadedData.get(i);
    if (data) {
      rowEl.innerHTML = `
        <div class="ts">${new Date(data.ts).toLocaleString()}</div>
        <div class="severity sev-${data.severity}">${data.severity}</div>
        <div class="service">${data.service}</div>
        <div class="message">${data.message}</div>
      `;
    } else {
      rowEl.innerHTML = `<div class="message">Loading...</div>`;
    }
    
    rowsContainer.appendChild(rowEl);
  }
}

async function loadDataForRange(startIndex, endIndex) {
  const chunkSize = 100;
  const startChunk = Math.floor(startIndex / chunkSize);
  const endChunk = Math.floor(endIndex / chunkSize);
  
  for (let chunk = startChunk; chunk <= endChunk; chunk++) {
    const chunkOffset = chunk * chunkSize;
    
    let hasChunk = true;
    for (let i = 0; i < chunkSize; i++) {
      if (chunkOffset + i >= totalRows && totalRows > 0) break;
      if (!loadedData.has(chunkOffset + i)) {
        hasChunk = false;
        break;
      }
    }
    
    if (hasChunk) continue;
    if (pendingRequests.has(chunkOffset)) continue;
    
    const controller = new AbortController();
    pendingRequests.set(chunkOffset, controller);
    
    try {
      const data = await fetchLogs(chunkOffset, chunkSize, controller.signal);
      updateRowCount(data.total);
      
      data.rows.forEach((row, idx) => {
        loadedData.set(chunkOffset + idx, row);
      });
      
      const currentScrollTop = viewport.scrollTop;
      const clientHeight = viewport.clientHeight || 800;
      const currentStartIndex = Math.max(0, Math.floor(currentScrollTop / ROW_HEIGHT) - OVERSCAN);
      const currentEndIndex = Math.min(totalRows - 1, Math.floor((currentScrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN);
      
      if (chunkOffset + chunkSize - 1 >= currentStartIndex && chunkOffset <= currentEndIndex) {
        renderRows(currentStartIndex, currentEndIndex);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error(e);
      }
    } finally {
      pendingRequests.delete(chunkOffset);
    }
  }
}

function onScroll() {
  const scrollTop = viewport.scrollTop;
  const clientHeight = viewport.clientHeight || 800;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalRows - 1, Math.floor((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN);
  
  renderRows(startIndex, endIndex);
  loadDataForRange(startIndex, endIndex);
}

function resetAndFetch() {
  for (const controller of pendingRequests.values()) {
    controller.abort();
  }
  pendingRequests.clear();
  loadedData.clear();
  
  viewport.scrollTop = 0;
  totalRows = 0;
  spacer.style.height = '0px';
  rowsContainer.innerHTML = '';
  
  const clientHeight = viewport.clientHeight || 800;
  loadDataForRange(0, Math.ceil(clientHeight / ROW_HEIGHT) + OVERSCAN);
}

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = e.target.value;
    resetAndFetch();
  }, 300);
});

viewport.addEventListener('scroll', onScroll);

fetchStats();
resetAndFetch();
