const API_BASE = 'http://localhost:3001';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 35; // approx
let visibleRows = 20;
let overscan = 5;
let isLoading = false;
let lastRequestId = 0;

const scroller = document.getElementById('virtual-scroller');
const content = document.getElementById('virtual-content');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-box');

let rowsData = []; // currently rendered rows
let startIndex = 0;

async function fetchLogs(offset, limit, filters) {
  const params = new URLSearchParams({ offset, limit, ...filters });
  const res = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!res.ok) throw new Error('Fetch failed');
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  return res.json();
}

function updateStats(stats) {
  statsEl.innerHTML = `
    Total: ${stats.total} | 
    Debug: ${stats.perSeverity.debug} | 
    Info: ${stats.perSeverity.info} | 
    Warn: ${stats.perSeverity.warn} | 
    Error: ${stats.perSeverity.error}
  `;
}

function updateRowCount(filteredTotal) {
  rowCountEl.textContent = `${rowsData.length} of ${filteredTotal}`;
}

function renderRows(rows, offset) {
  content.innerHTML = '';
  content.style.height = `${currentTotal * rowHeight}px`;

  rows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = `log-row`;
    const ts = new Date(row.ts).toISOString();
    div.innerHTML = `
      <div class="col-ts">${ts}</div>
      <div class="col-sev ${row.severity}">${row.severity.toUpperCase()}</div>
      <div class="col-svc">${row.service}</div>
      <div class="col-msg">${row.message}</div>
    `;
    div.style.position = 'absolute';
    div.style.top = `${(offset + i) * rowHeight}px`;
    div.style.height = `${rowHeight}px`;
    div.style.width = '100%';
    content.appendChild(div);
  });
}

let debounceTimer;
function debounceSearch(fn, delay = 300) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), delay);
  };
}

async function loadWindow(offset, filters) {
  if (isLoading) return;
  isLoading = true;
  const requestId = ++lastRequestId;

  try {
    const limit = visibleRows + overscan * 2;
    const data = await fetchLogs(offset, limit, filters);

    if (requestId !== lastRequestId) return; // stale

    currentTotal = data.total;
    rowsData = data.rows;
    startIndex = offset;

    content.style.height = `${currentTotal * rowHeight}px`;
    renderRows(data.rows, offset);
    updateRowCount(currentTotal);
  } catch (e) {
    console.error(e);
  } finally {
    isLoading = false;
  }
}

function onScroll() {
  const scrollTop = scroller.scrollTop;
  const newStart = Math.floor(scrollTop / rowHeight);
  const adjustedStart = Math.max(0, newStart - overscan);

  if (Math.abs(adjustedStart - startIndex) > overscan || rowsData.length === 0) {
    loadWindow(adjustedStart, currentFilters);
  }
}

function resetAndLoad() {
  currentFilters = {
    severity: severitySelect.value,
    q: searchInput.value.trim()
  };
  content.innerHTML = '';
  rowsData = [];
  startIndex = 0;
  scroller.scrollTop = 0;
  loadWindow(0, currentFilters);
}

async function init() {
  // Initial stats
  const stats = await fetchStats();
  updateStats(stats);

  // Initial load
  await loadWindow(0, currentFilters);

  // Event listeners
  severitySelect.addEventListener('change', resetAndLoad);

  searchInput.addEventListener('input', debounceSearch(() => {
    resetAndLoad();
  }));

  scroller.addEventListener('scroll', onScroll);

  // Set initial height
  content.style.height = `${currentTotal * rowHeight}px`;

  // Keyboard support etc, but basic ok
  console.log('Log explorer initialized');
}

init();