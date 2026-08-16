const API_BASE = '/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let overscan = 10;
let visibleRowsContainer;
let spacer;
let tableContainer;
let debounceTimer = null;
let currentRequestController = null;
let lastFetchKey = '';

function formatTimestamp(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function createRowElement(row) {
  const div = document.createElement('div');
  div.className = 'log-row';
  div.innerHTML = `
    <div class="col-ts">${formatTimestamp(row.ts)}</div>
    <div class="col-sev severity-${row.severity}">${row.severity.toUpperCase()}</div>
    <div class="col-svc">${row.service}</div>
    <div class="col-msg" title="${row.message.replace(/"/g, '&quot;')}">${row.message}</div>
  `;
  return div;
}

async function fetchLogs(offset, limit, signal) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (currentFilter.severity) params.set('severity', currentFilter.severity);
  if (currentFilter.q) params.set('q', currentFilter.q);

  const res = await fetch(`${API_BASE}/logs?${params}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  return res.json();
}

function updateStats(stats) {
  const container = document.getElementById('stats-bar');
  container.innerHTML = `
    <span class="badge">Total: ${stats.total.toLocaleString()}</span>
    <span class="badge">Debug: ${stats.bySeverity.debug || 0}</span>
    <span class="badge">Info: ${stats.bySeverity.info || 0}</span>
    <span class="badge">Warn: ${stats.bySeverity.warn || 0}</span>
    <span class="badge">Error: ${stats.bySeverity.error || 0}</span>
  `;
}

function updateRowCount() {
  const el = document.getElementById('row-count');
  el.textContent = `${currentTotal.toLocaleString()} of ${currentTotal.toLocaleString()} rows`;
}

function renderVisibleRows(rows, startOffset) {
  visibleRowsContainer.innerHTML = '';
  visibleRowsContainer.style.position = 'absolute';
  visibleRowsContainer.style.top = `${startOffset * rowHeight}px`;
  visibleRowsContainer.style.width = '100%';

  rows.forEach(row => {
    visibleRowsContainer.appendChild(createRowElement(row));
  });
}

async function loadWindow(startRow, force = false) {
  const limit = 100; // fetch a bit more than visible
  const fetchKey = `${currentFilter.severity}|${currentFilter.q}|${startRow}`;

  if (!force && fetchKey === lastFetchKey) return;

  // Cancel previous
  if (currentRequestController) {
    currentRequestController.abort();
  }
  currentRequestController = new AbortController();

  try {
    const data = await fetchLogs(startRow, limit, currentRequestController.signal);
    
    // Update total if changed (filter change)
    if (data.total !== currentTotal) {
      currentTotal = data.total;
      spacer.style.height = `${currentTotal * rowHeight}px`;
      updateRowCount();
    }

    // Render
    const visibleStart = Math.max(0, startRow);
    renderVisibleRows(data.rows, visibleStart);

    lastFetchKey = fetchKey;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch error:', err);
    }
  }
}

function getVisibleStartRow() {
  const scrollTop = tableContainer.scrollTop;
  return Math.floor(scrollTop / rowHeight);
}

function setupVirtualScroll() {
  let ticking = false;

  tableContainer.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        const startRow = getVisibleStartRow() - overscan;
        const clampedStart = Math.max(0, startRow);
        loadWindow(clampedStart);
        ticking = false;
      });
      ticking = true;
    }
  });
}

function setupFilters() {
  const severitySelect = document.getElementById('severity-filter');
  const searchInput = document.getElementById('search-input');

  function applyFilters() {
    currentFilter.severity = severitySelect.value;
    currentFilter.q = searchInput.value.trim();

    // Reset scroll and state
    tableContainer.scrollTop = 0;
    currentTotal = 0;
    spacer.style.height = '0px';
    visibleRowsContainer.innerHTML = '';
    lastFetchKey = '';

    // Load from top
    loadWindow(0, true);
  }

  severitySelect.addEventListener('change', applyFilters);

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyFilters();
    }, 250);
  });
}

async function init() {
  visibleRowsContainer = document.getElementById('visible-rows');
  spacer = document.getElementById('virtual-spacer');
  tableContainer = document.getElementById('table-container');

  // Initial stats
  try {
    const stats = await fetchStats();
    updateStats(stats);
  } catch (e) {
    console.error('Failed to load stats', e);
  }

  // Initial load
  currentTotal = 0;
  spacer.style.height = '0px';
  await loadWindow(0, true);

  // After first load, set proper height if needed
  if (currentTotal > 0) {
    spacer.style.height = `${currentTotal * rowHeight}px`;
  }

  setupVirtualScroll();
  setupFilters();

  // Initial row count
  updateRowCount();

  // Keyboard hint
  console.log('%c[Log Explorer] Virtualized table ready. Scroll to test deep offsets.', 'color:#888');
}

init();