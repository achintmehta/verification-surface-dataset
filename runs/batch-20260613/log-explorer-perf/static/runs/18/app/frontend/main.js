const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const API_URL = 'http://localhost:3000/api';

let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let logsCache = new Map(); // offset -> row data
let inFlightRequests = new Map(); // offset -> AbortController
let scrollTimeout = null;
let searchTimeout = null;

const container = document.getElementById('table-container');
const spacer = document.getElementById('table-spacer');
const content = document.getElementById('table-content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDiv = document.getElementById('stats');

let absoluteTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    absoluteTotal = data.total;
    updateStatsDisplay(totalRows);
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

async function fetchLogs(offset, limit, signal) {
  const params = new URLSearchParams({ offset, limit });
  if (currentSeverity) params.append('severity', currentSeverity);
  if (currentQuery) params.append('q', currentQuery);

  const res = await fetch(`${API_URL}/logs?${params.toString()}`, { signal });
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
}

function updateStatsDisplay(total) {
  if (absoluteTotal > 0) {
    statsDiv.textContent = `${total} of ${absoluteTotal}`;
  } else {
    statsDiv.textContent = `${total} rows found`;
  }
}

async function loadInitialData() {
  logsCache.clear();
  for (const [key, controller] of inFlightRequests.entries()) {
    controller.abort();
  }
  inFlightRequests.clear();

  try {
    const data = await fetchLogs(0, 50);
    totalRows = data.total;
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
    updateStatsDisplay(totalRows);
    
    for (let i = 0; i < data.rows.length; i++) {
      logsCache.set(i, data.rows[i]);
    }
    
    container.scrollTop = 0;
    renderViewport();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to load initial data', err);
    }
  }
}

function renderRow(index, row) {
  const div = document.createElement('div');
  div.className = 'log-row';
  div.style.top = `${index * ROW_HEIGHT}px`;
  
  if (!row) {
    div.innerHTML = `<div class="col-message">Loading...</div>`;
    return div;
  }

  const ts = new Date(row.ts).toISOString().replace('T', ' ').substring(0, 19);
  
  div.innerHTML = `
    <div class="col-ts">${ts}</div>
    <div class="col-severity sev-${row.severity}">${row.severity}</div>
    <div class="col-service">${row.service}</div>
    <div class="col-message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
  `;
  return div;
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function renderViewport() {
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;
  
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  
  content.innerHTML = '';
  
  const missingRanges = [];
  let currentRange = null;

  for (let i = startIndex; i <= endIndex; i++) {
    const row = logsCache.get(i);
    content.appendChild(renderRow(i, row));
    
    if (!row) {
      if (!currentRange) {
        currentRange = { start: i, end: i };
      } else {
        currentRange.end = i;
      }
    } else {
      if (currentRange) {
        missingRanges.push(currentRange);
        currentRange = null;
      }
    }
  }
  if (currentRange) {
    missingRanges.push(currentRange);
  }

  // Fetch missing ranges
  for (const range of missingRanges) {
    let currentOffset = range.start;
    while (currentOffset <= range.end) {
      const chunkOffset = Math.floor(currentOffset / 50) * 50;
      const chunkLimit = 50;
      
      if (!inFlightRequests.has(chunkOffset)) {
        const controller = new AbortController();
        inFlightRequests.set(chunkOffset, controller);
        
        fetchLogs(chunkOffset, chunkLimit, controller.signal)
          .then(data => {
            inFlightRequests.delete(chunkOffset);
            let needsRender = false;
            for (let i = 0; i < data.rows.length; i++) {
              const idx = chunkOffset + i;
              logsCache.set(idx, data.rows[i]);
              if (idx >= startIndex && idx <= endIndex) {
                needsRender = true;
              }
            }
            if (needsRender) {
              renderViewport();
            }
          })
          .catch(err => {
            if (err.name !== 'AbortError') {
              console.error('Failed to fetch chunk', err);
              inFlightRequests.delete(chunkOffset);
            }
          });
      }
      currentOffset = chunkOffset + chunkLimit;
    }
  }
}

container.addEventListener('scroll', () => {
  if (scrollTimeout) cancelAnimationFrame(scrollTimeout);
  scrollTimeout = requestAnimationFrame(() => {
    renderViewport();
  });
});

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  loadInitialData();
});

searchInput.addEventListener('input', (e) => {
  currentQuery = e.target.value;
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    loadInitialData();
  }, 300);
});

// Init
fetchStats();
loadInitialData();
