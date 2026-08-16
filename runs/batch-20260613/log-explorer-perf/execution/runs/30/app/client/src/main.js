const API_BASE = 'http://localhost:3001/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32; // approx row height
let visibleRows = 20;
let overscan = 5;
let isLoading = false;
let lastRequestId = 0;

const scroller = document.getElementById('virtual-scroller');
const content = document.getElementById('virtual-content');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let debounceTimer = null;
let currentRows = [];
let currentOffset = 0;

function updateRowCount() {
  rowCountEl.textContent = `${currentRows.length} of ${currentTotal.toLocaleString()}`;
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    statsEl.innerHTML = `
      Total: <strong>${data.total.toLocaleString()}</strong> | 
      Debug: ${data.perSeverity.debug} | 
      Info: ${data.perSeverity.info} | 
      Warn: ${data.perSeverity.warn} | 
      Error: ${data.perSeverity.error}
    `;
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

async function fetchLogs(offset, limit, severity, q) {
  const requestId = ++lastRequestId;
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (severity) params.append('severity', severity);
  if (q) params.append('q', q);

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

  if (!rows || rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-row';
    empty.style.position = 'absolute';
    empty.style.top = '0';
    empty.innerHTML = '<div style="padding: 20px; color: #888;">No logs found for current filters.</div>';
    content.appendChild(empty);
    return;
  }

  rows.forEach((row, idx) => {
    const el = document.createElement('div');
    el.className = `log-row severity-${row.severity}`;
    el.style.position = 'absolute';
    el.style.top = `${(startOffset + idx) * rowHeight}px`;
    el.style.height = `${rowHeight}px`;
    el.style.width = '100%';
    el.innerHTML = `
      <div class="col-ts">${new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19)}</div>
      <div class="col-sev">${row.severity.toUpperCase()}</div>
      <div class="col-svc">${row.service}</div>
      <div class="col-msg">${escapeHtml(row.message)}</div>
    `;
    content.appendChild(el);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function loadWindow(offset) {
  if (isLoading) return;
  isLoading = true;

  const limit = visibleRows + overscan * 2;
  const fetchOffset = Math.max(0, offset - overscan);

  try {
    const data = await fetchLogs(fetchOffset, limit, currentFilters.severity, currentFilters.q);
    if (data === null) return; // stale

    currentTotal = data.total;
    currentRows = data.rows;
    currentOffset = fetchOffset;

    renderRows(currentRows, fetchOffset);
    updateRowCount();
  } catch (e) {
    console.error('Load failed:', e);
    content.innerHTML = `<div class="log-row" style="position:absolute;top:0;color:red;">Error loading logs: ${e.message}</div>`;
  } finally {
    isLoading = false;
  }
}

function onScroll() {
  const scrollTop = scroller.scrollTop;
  const approxRow = Math.floor(scrollTop / rowHeight);
  const neededOffset = Math.max(0, approxRow - overscan);

  // Check if we need to load new window
  if (Math.abs(neededOffset - currentOffset) > overscan || currentRows.length === 0) {
    loadWindow(approxRow);
  }
}

function resetAndLoad() {
  currentRows = [];
  currentOffset = 0;
  content.innerHTML = '';
  content.style.height = '0px';
  scroller.scrollTop = 0;
  loadWindow(0);
}

function setupEventListeners() {
  severitySelect.addEventListener('change', () => {
    currentFilters.severity = severitySelect.value;
    resetAndLoad();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilters.q = searchInput.value.trim();
      resetAndLoad();
    }, 300);
  });

  scroller.addEventListener('scroll', () => {
    // Throttle scroll handling
    if (!window.scrollThrottle) {
      window.scrollThrottle = setTimeout(() => {
        onScroll();
        window.scrollThrottle = null;
      }, 50);
    }
  });

  // Handle window resize for visible rows calc
  window.addEventListener('resize', () => {
    visibleRows = Math.ceil(scroller.clientHeight / rowHeight) + 2;
  });
}

async function init() {
  visibleRows = Math.ceil(scroller.clientHeight / rowHeight) + 2;

  await fetchStats();
  await loadWindow(0);

  setupEventListeners();

  // Initial scroll listener setup
  console.log('Log Explorer initialized');
}

init();