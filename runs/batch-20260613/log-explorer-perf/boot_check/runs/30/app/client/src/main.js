const API_BASE = 'http://localhost:3001/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let overscan = 10;
let visibleRows = [];
let isLoading = false;
let lastRequestTime = 0;
let abortController = null;

const container = document.getElementById('virtual-container');
const inner = document.getElementById('virtual-inner');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let debounceTimer = null;

function updateRowCount() {
  rowCountEl.textContent = `${visibleRows.length} of ${currentTotal.toLocaleString()}`;
}

function createRowElement(row, top) {
  const div = document.createElement('div');
  div.className = `log-row sev-${row.severity}`;
  div.style.top = `${top}px`;
  div.innerHTML = `
    <div class="col-ts">${new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19)}</div>
    <div class="col-sev">${row.severity.toUpperCase()}</div>
    <div class="col-svc">${row.service}</div>
    <div class="col-msg" title="${row.message}">${row.message}</div>
  `;
  return div;
}

function renderVisibleRows(rows, startOffset) {
  inner.innerHTML = '';
  inner.style.height = `${currentTotal * rowHeight}px`;

  visibleRows = rows;
  rows.forEach((row, idx) => {
    const top = (startOffset + idx) * rowHeight;
    const el = createRowElement(row, top);
    inner.appendChild(el);
  });

  updateRowCount();
}

async function fetchLogs(offset, limit = 100) {
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (currentFilter.severity) params.set('severity', currentFilter.severity);
  if (currentFilter.q) params.set('q', currentFilter.q);

  const requestTime = Date.now();
  lastRequestTime = requestTime;

  try {
    const res = await fetch(`${API_BASE}/logs?${params}`, {
      signal: abortController.signal
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Request failed');
    }
    const data = await res.json();

    // Ignore stale responses
    if (requestTime < lastRequestTime) {
      return null;
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('Fetch error:', err);
    return null;
  }
}

async function loadWindow(scrollTop) {
  if (isLoading) return;
  isLoading = true;

  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endRow = Math.min(currentTotal, Math.ceil((scrollTop + container.clientHeight) / rowHeight) + overscan);
  const limit = Math.min(200, endRow - startRow + 1);

  if (limit <= 0 || currentTotal === 0) {
    isLoading = false;
    return;
  }

  const data = await fetchLogs(startRow, limit);
  if (data && data.rows) {
    // Adjust if total changed
    if (data.total !== currentTotal) {
      currentTotal = data.total;
      inner.style.height = `${currentTotal * rowHeight}px`;
    }
    renderVisibleRows(data.rows, startRow);
  }

  isLoading = false;
}

function onScroll() {
  const scrollTop = container.scrollTop;
  loadWindow(scrollTop);
}

let scrollTimeout = null;
function debouncedScroll() {
  if (scrollTimeout) clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    onScroll();
  }, 16); // ~60fps
}

async function applyFilters(resetScroll = true) {
  currentFilter.severity = severitySelect.value;
  currentFilter.q = searchInput.value.trim();

  // Fetch total first via stats or logs with limit 1
  const data = await fetchLogs(0, 1);
  if (data) {
    currentTotal = data.total;
    inner.style.height = `${currentTotal * rowHeight}px`;
    inner.innerHTML = '';
    visibleRows = [];
    updateRowCount();

    if (resetScroll) {
      container.scrollTop = 0;
    }
    await loadWindow(container.scrollTop || 0);
  }
}

function setupEventListeners() {
  severitySelect.addEventListener('change', () => applyFilters(true));

  searchInput.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyFilters(true);
    }, 300);
  });

  container.addEventListener('scroll', debouncedScroll);

  // Initial load and handle resize
  window.addEventListener('resize', () => {
    if (currentTotal > 0) {
      loadWindow(container.scrollTop);
    }
  });
}

async function init() {
  // Load initial stats and data
  try {
    const statsRes = await fetch(`${API_BASE}/stats`);
    const stats = await statsRes.json();
    // Can use stats if needed for badges, but we use dynamic total

    currentTotal = stats.total;
    inner.style.height = `${currentTotal * rowHeight}px`;
  } catch (e) {
    console.error('Failed to load stats', e);
    currentTotal = 100000; // fallback
    inner.style.height = `${currentTotal * rowHeight}px`;
  }

  setupEventListeners();
  await loadWindow(0);
  updateRowCount();
}

init();