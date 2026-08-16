const API_URL = 'http://localhost:3000/api';
const ROW_HEIGHT = 32;
const OVERSCAN = 20;
const LIMIT = 200;

let state = {
  total: 0,
  rows: [],
  offset: 0,
  severity: '',
  q: '',
  stats: null
};

let abortController = null;
let debounceTimer = null;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsEl = document.getElementById('stats');

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    state.stats = await res.json();
    updateStatsDisplay();
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

function updateStatsDisplay() {
  if (!state.stats) return;
  statsEl.textContent = `${state.total} of ${state.stats.total} rows`;
  
  const options = severityFilter.options;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const val = opt.value;
    if (val === '') {
      opt.textContent = `All Severities (${state.stats.total})`;
    } else {
      const count = state.stats[val] || 0;
      const label = val.charAt(0).toUpperCase() + val.slice(1);
      opt.textContent = `${label} (${count})`;
    }
  }
}

async function fetchLogs(offset, severity, q) {
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();
  
  try {
    const params = new URLSearchParams({
      offset,
      limit: LIMIT
    });
    if (severity) params.append('severity', severity);
    if (q) params.append('q', q);
    
    const res = await fetch(`${API_URL}/logs?${params.toString()}`, {
      signal: abortController.signal
    });
    
    if (!res.ok) throw new Error('API error');
    
    const data = await res.json();
    return data;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('Failed to fetch logs', err);
    return null;
  }
}

async function loadData(force = false) {
  const currentOffset = Math.floor(viewport.scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT);
  
  if (!force && state.rows.length > 0) {
    const loadedStart = state.offset;
    const loadedEnd = state.offset + state.rows.length;
    const visibleEnd = currentOffset + visibleCount;
    
    // If we have the visible rows plus a small buffer, no need to fetch
    // Also consider if we've reached the end of the total rows
    if (currentOffset >= loadedStart && (visibleEnd <= loadedEnd || loadedEnd === state.total)) {
      return;
    }
  }
  
  // Fetch a new window centered around the current scroll position
  // We want to fetch LIMIT rows, starting a bit before the current offset
  const fetchOffset = Math.max(0, currentOffset - OVERSCAN);
  
  const data = await fetchLogs(fetchOffset, state.severity, state.q);
  if (!data) return; // Aborted or error
  
  state.total = data.total;
  state.rows = data.rows;
  state.offset = fetchOffset;
  
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  updateStatsDisplay();
  renderRows();
}

const rowPool = [];

function getRowEl(i) {
  if (i < rowPool.length) {
    const el = rowPool[i];
    el.style.display = 'flex';
    return el;
  }
  
  const rowEl = document.createElement('div');
  rowEl.className = 'log-row';
  rowEl.style.position = 'absolute';
  rowEl.style.left = '0';
  rowEl.style.right = '0';
  
  const tsEl = document.createElement('div');
  tsEl.className = 'col-ts';
  
  const sevEl = document.createElement('div');
  
  const svcEl = document.createElement('div');
  svcEl.className = 'col-svc';
  
  const msgEl = document.createElement('div');
  msgEl.className = 'col-msg';
  
  rowEl.appendChild(tsEl);
  rowEl.appendChild(sevEl);
  rowEl.appendChild(svcEl);
  rowEl.appendChild(msgEl);
  
  rowsContainer.appendChild(rowEl);
  rowPool.push(rowEl);
  
  return rowEl;
}

function renderRows() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight || 800;
  
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const endIndex = Math.min(state.total - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT));
  
  // Hide all rows in the pool first
  for (const el of rowPool) {
    el.style.display = 'none';
  }
  
  let poolIndex = 0;
  
  for (let i = startIndex; i <= endIndex; i++) {
    const rowIndex = i - state.offset;
    const row = state.rows[rowIndex];
    
    if (!row) continue;
    
    const rowEl = getRowEl(poolIndex++);
    rowEl.style.top = `${i * ROW_HEIGHT}px`;
    
    const [tsEl, sevEl, svcEl, msgEl] = rowEl.children;
    
    tsEl.textContent = new Date(row.ts).toLocaleString();
    sevEl.className = `col-sev sev-${row.severity}`;
    sevEl.textContent = row.severity.toUpperCase();
    svcEl.textContent = row.service;
    msgEl.textContent = row.message;
    msgEl.title = row.message;
  }
}

viewport.addEventListener('scroll', () => {
  renderRows();
  loadData();
});

severityFilter.addEventListener('change', (e) => {
  state.severity = e.target.value;
  viewport.scrollTop = 0;
  loadData(true);
});

searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = e.target.value;
    viewport.scrollTop = 0;
    loadData(true);
  }, 300);
});

// Initial load
async function init() {
  await fetchStats();
  await loadData(true);
}

init();