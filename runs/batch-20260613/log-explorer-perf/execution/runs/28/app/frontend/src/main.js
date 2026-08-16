const API_BASE = 'http://localhost:3001/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let visibleRows = 20;
let overscan = 5;
let isLoading = false;
let requestVersion = 0;
let abortController = null;

const container = document.getElementById('virtual-container');
const inner = document.getElementById('virtual-inner');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');

let renderedRows = new Map(); // offset -> element

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

async function fetchLogs(offset, limit, filter) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filter.severity) params.set('severity', filter.severity);
  if (filter.q) params.set('q', filter.q);

  if (abortController) abortController.abort();
  abortController = new AbortController();

  const res = await fetch(`${API_BASE}/logs?${params}`, {
    signal: abortController.signal
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  return res.json();
}

function updateRowCount() {
  rowCountEl.textContent = `${renderedRows.size} of ${currentTotal}`;
}

function updateStats(stats) {
  const parts = [`Total: ${stats.total}`];
  Object.entries(stats.perSeverity).forEach(([sev, cnt]) => {
    parts.push(`${sev}: ${cnt}`);
  });
  statsEl.textContent = parts.join(' | ');
}

function createRowElement(row, top) {
  const el = document.createElement('div');
  el.className = `log-row sev-${row.severity}`;
  el.style.top = `${top}px`;

  const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
  el.innerHTML = `
    <div class="col-ts">${ts}</div>
    <div class="col-sev">${row.severity.toUpperCase()}</div>
    <div class="col-svc">${row.service}</div>
    <div class="col-msg" title="${row.message}">${row.message}</div>
  `;
  return el;
}

function renderWindow(startOffset, rows) {
  // Clear previous
  inner.innerHTML = '';
  renderedRows.clear();

  const fragment = document.createDocumentFragment();
  rows.forEach((row, i) => {
    const offset = startOffset + i;
    const top = offset * rowHeight;
    const el = createRowElement(row, top);
    fragment.appendChild(el);
    renderedRows.set(offset, el);
  });

  inner.style.height = `${currentTotal * rowHeight}px`;
  inner.appendChild(fragment);
  updateRowCount();
}

async function loadWindow(offset, filterVersion) {
  if (filterVersion !== requestVersion) return; // stale

  try {
    isLoading = true;
    const limit = Math.min(100, currentTotal - offset);
    if (limit <= 0) return;

    const data = await fetchLogs(offset, limit, currentFilter);
    if (filterVersion !== requestVersion) return; // stale response

    currentTotal = data.total;
    renderWindow(offset, data.rows);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Load error:', e);
    }
  } finally {
    isLoading = false;
  }
}

function onScroll() {
  const scrollTop = container.scrollTop;
  const startOffset = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endOffset = Math.min(currentTotal, startOffset + visibleRows + overscan * 2);

  // Check if we need to load new window
  const needsLoad = !renderedRows.has(startOffset) && !isLoading;
  if (needsLoad && currentTotal > 0) {
    const v = requestVersion;
    loadWindow(startOffset, v);
  }
}

function resetAndLoad() {
  requestVersion++;
  const v = requestVersion;
  renderedRows.clear();
  inner.innerHTML = '';
  inner.style.height = '0px';

  // Initial load at top
  loadWindow(0, v);
  updateRowCount();
}

async function initFilters() {
  severitySelect.addEventListener('change', () => {
    currentFilter.severity = severitySelect.value;
    resetAndLoad();
  });

  const debouncedSearch = debounce(() => {
    currentFilter.q = searchInput.value.trim();
    resetAndLoad();
  }, 300);

  searchInput.addEventListener('input', debouncedSearch);

  // Load initial stats
  try {
    const stats = await fetchStats();
    updateStats(stats);
    currentTotal = stats.total;
    inner.style.height = `${currentTotal * rowHeight}px`;
  } catch (e) {
    console.error(e);
  }

  // Initial data load
  resetAndLoad();
}

function initVirtualScroll() {
  container.addEventListener('scroll', onScroll, { passive: true });

  // Set initial height
  container.style.height = '600px';
  visibleRows = Math.ceil(600 / rowHeight) + 2;
}

async function init() {
  initVirtualScroll();
  await initFilters();

  // Poll stats occasionally? not needed
  console.log('Log Explorer initialized');
}

init();