const ROW_HEIGHT = 30;
const OVERSCAN = 10;
const LIMIT = 100;

let totalRows = 0;
let corpusTotal = 0;
let currentSeverity = '';
let currentQuery = '';

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountDisplay = document.getElementById('row-count');

let cachedRows = new Map();
let fetchingOffsets = new Set();
let loadedOffsets = new Set();
let currentAbortController = new AbortController();

async function fetchLogs(offset) {
  const signal = currentAbortController.signal;
  try {
    const params = new URLSearchParams({
      offset,
      limit: LIMIT,
    });
    if (currentSeverity) params.set('severity', currentSeverity);
    if (currentQuery) params.set('q', currentQuery);

    const res = await fetch(\`/api/logs?\${params.toString()}\`, { signal });
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    
    if (signal.aborted) return;

    if (totalRows !== data.total) {
      totalRows = data.total;
      spacer.style.height = \`\${totalRows * ROW_HEIGHT}px\`;
      rowCountDisplay.textContent = \`\${totalRows} of \${corpusTotal}\`;
    }

    for (let i = 0; i < data.rows.length; i++) {
      cachedRows.set(offset + i, data.rows[i]);
    }
    loadedOffsets.add(offset);

    renderVisibleRows();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch error:', err);
    }
  }
}

const rowElements = [];

function renderVisibleRows() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight || 800;

  const startIdx = Math.floor(scrollTop / ROW_HEIGHT);
  const endIdx = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const renderStart = Math.min(Math.max(0, startIdx - OVERSCAN), maxIdx);
  const renderEnd = Math.max(renderStart, Math.min(maxIdx, endIdx + OVERSCAN));

  const fetchStartOffset = Math.floor(renderStart / LIMIT) * LIMIT;
  const fetchEndOffset = Math.floor(renderEnd / LIMIT) * LIMIT;

  for (let offset = fetchStartOffset; offset <= fetchEndOffset; offset += LIMIT) {
    if (!loadedOffsets.has(offset) && !fetchingOffsets.has(offset)) {
      fetchingOffsets.add(offset);
      fetchLogs(offset).finally(() => {
        fetchingOffsets.delete(offset);
      });
    }
  }

  const requiredElements = Math.max(0, renderEnd - renderStart + 1);
  
  while (rowElements.length < requiredElements) {
    const el = document.createElement('div');
    el.className = 'log-row';
    el.style.height = \`\${ROW_HEIGHT}px\`;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    rowsContainer.appendChild(el);
    rowElements.push(el);
  }
  
  for (let i = requiredElements; i < rowElements.length; i++) {
    rowElements[i].style.display = 'none';
  }

  for (let i = 0; i < requiredElements; i++) {
    const rowIndex = renderStart + i;
    if (totalRows === 0 && rowIndex > 0) {
      rowElements[i].style.display = 'none';
      continue;
    }

    const el = rowElements[i];
    el.style.display = 'flex';
    el.style.transform = \`translateY(\${rowIndex * ROW_HEIGHT}px)\`;

    const rowData = cachedRows.get(rowIndex);
    if (rowData) {
      el.innerHTML = \`
        <div class="ts">\${new Date(rowData.ts).toISOString().replace('T', ' ').substring(0, 19)}</div>
        <div class="severity sev-\${rowData.severity}">\${rowData.severity}</div>
        <div class="service">\${rowData.service}</div>
        <div class="message" title="\${escapeHtml(rowData.message)}">\${escapeHtml(rowData.message)}</div>
      \`;
    } else if (totalRows === 0 && loadedOffsets.has(0)) {
      el.innerHTML = \`<div class="message">No results found.</div>\`;
    } else {
      el.innerHTML = \`<div class="message">Loading...</div>\`;
    }
  }
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

viewport.addEventListener('scroll', () => {
  requestAnimationFrame(renderVisibleRows);
});

function resetAndFetch() {
  currentAbortController.abort();
  currentAbortController = new AbortController();
  cachedRows.clear();
  fetchingOffsets.clear();
  loadedOffsets.clear();
  viewport.scrollTop = 0;
  
  totalRows = 0;
  spacer.style.height = '0px';
  rowCountDisplay.textContent = 'Loading...';
  renderVisibleRows();
}

severityFilter.addEventListener('change', (e) => {
  currentSeverity = e.target.value;
  resetAndFetch();
});

let debounceTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    currentQuery = e.target.value;
    resetAndFetch();
  }, 300);
});

// Initial fetch
async function init() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    corpusTotal = data.total;
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
  resetAndFetch();
}

init();
