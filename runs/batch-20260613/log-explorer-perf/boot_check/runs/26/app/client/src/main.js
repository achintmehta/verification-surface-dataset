const API_BASE = 'http://localhost:3001';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 28;
let visibleRows = 25; // approx
let overscan = 5;
let isFetching = false;
let lastFetchController = null;

const container = document.getElementById('table-container');
const inner = document.getElementById('virtual-inner');
const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsEl = document.getElementById('stats-badges');

let rowsData = []; // currently loaded rows
let loadedOffset = 0;
let loadedLimit = 0;

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const data = await res.json();
    renderStats(data);
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

function renderStats(data) {
  statsEl.innerHTML = '';
  const severities = ['debug', 'info', 'warn', 'error'];
  severities.forEach(sev => {
    const count = data.bySeverity[sev] || 0;
    const badge = document.createElement('span');
    badge.className = `badge ${sev}`;
    badge.textContent = `${sev}: ${count.toLocaleString()}`;
    statsEl.appendChild(badge);
  });
}

function updateRowCount() {
  const start = loadedOffset + 1;
  const end = Math.min(loadedOffset + rowsData.length, currentTotal);
  rowCountEl.textContent = `${end - start + 1} rows visible • ${currentTotal.toLocaleString()} total`;
  if (currentFilter.q || currentFilter.severity) {
    rowCountEl.textContent += ` (filtered)`;
  }
}

async function fetchLogs(offset, limit, filter) {
  if (lastFetchController) {
    lastFetchController.abort();
  }
  lastFetchController = new AbortController();

  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (filter.severity) params.set('severity', filter.severity);
  if (filter.q) params.set('q', filter.q);

  const url = `${API_BASE}/api/logs?${params.toString()}`;
  try {
    const res = await fetch(url, { signal: lastFetchController.signal });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Request failed');
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

function renderRows(rows, baseOffset) {
  inner.innerHTML = '';
  inner.style.height = `${currentTotal * rowHeight}px`;

  rows.forEach((row, idx) => {
    const el = document.createElement('div');
    el.className = 'log-row';
    const top = (baseOffset + idx) * rowHeight;
    el.style.top = `${top}px`;

    const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
    const sevClass = row.severity;

    el.innerHTML = `
      <div class="col-ts">${ts}</div>
      <div class="col-sev ${sevClass}">${row.severity}</div>
      <div class="col-svc">${row.service}</div>
      <div class="col-msg" title="${row.message.replace(/"/g, '&quot;')}">${row.message}</div>
    `;
    inner.appendChild(el);
  });
}

async function loadWindow(offset, filterChanged = false) {
  if (isFetching) return;
  isFetching = true;

  const limit = 200; // max allowed
  try {
    const data = await fetchLogs(offset, limit, currentFilter);
    if (!data) {
      isFetching = false;
      return;
    }

    currentTotal = data.total;
    rowsData = data.rows;
    loadedOffset = offset;
    loadedLimit = limit;

    renderRows(rowsData, loadedOffset);
    updateRowCount();

    // Adjust inner height always
    inner.style.height = `${currentTotal * rowHeight}px`;
  } catch (e) {
    console.error('Fetch error', e);
  } finally {
    isFetching = false;
  }
}

function getVisibleRange() {
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;
  const startIdx = Math.floor(scrollTop / rowHeight);
  const endIdx = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  return { startIdx, endIdx };
}

function onScroll() {
  const { startIdx, endIdx } = getVisibleRange();
  const neededStart = Math.max(0, startIdx - overscan);
  const neededEnd = Math.min(currentTotal, endIdx + overscan);

  // Check if we need to fetch new window
  const currentEnd = loadedOffset + rowsData.length;
  const needsRefetch = neededStart < loadedOffset || neededEnd > currentEnd;

  if (needsRefetch && !isFetching && currentTotal > 0) {
    // Fetch a window around the visible area, capped at 200
    const fetchOffset = Math.max(0, neededStart);
    const fetchLimit = Math.min(200, Math.max(50, neededEnd - fetchOffset + 10));
    loadWindow(fetchOffset);
  }
}

function setupVirtualScroll() {
  container.addEventListener('scroll', debounce(onScroll, 50));

  // Initial size
  setTimeout(() => {
    const { startIdx } = getVisibleRange();
    loadWindow(Math.max(0, startIdx - overscan));
  }, 100);
}

function applyFilters() {
  currentFilter = {
    severity: severitySelect.value,
    q: searchInput.value.trim()
  };
  // Reset scroll and load from top
  container.scrollTop = 0;
  loadWindow(0, true);
}

function setupFilters() {
  severitySelect.addEventListener('change', applyFilters);

  const debouncedSearch = debounce(() => {
    applyFilters();
  }, 300);

  searchInput.addEventListener('input', debouncedSearch);
}

async function init() {
  await fetchStats();
  setupFilters();
  setupVirtualScroll();

  // Initial load
  await loadWindow(0);

  // Make sure height is set
  inner.style.height = `${currentTotal * rowHeight}px`;
}

init();