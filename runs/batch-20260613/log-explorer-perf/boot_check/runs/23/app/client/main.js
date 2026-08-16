const API_BASE = '/api';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FETCH_LIMIT = 100; // rows per API call
const DEBOUNCE_MS = 250;

// State
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let fetchVersion = 0; // monotonically increasing to detect stale responses
let cache = new Map(); // pageIndex -> { rows, version }
let pendingFetches = new Map(); // pageIndex -> AbortController

// DOM elements
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowContainer = document.getElementById('row-container');
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// ---- API ----

async function fetchLogs(offset, limit, version, signal) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  const resp = await fetch(`${API_BASE}/logs?${params}`, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data;
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ---- Cache / Page management ----

function getPageIndex(rowIndex) {
  return Math.floor(rowIndex / FETCH_LIMIT);
}

function invalidateCache() {
  // Cancel all pending fetches
  for (const [, controller] of pendingFetches) {
    controller.abort();
  }
  pendingFetches.clear();
  cache.clear();
}

async function ensurePage(pageIndex) {
  const version = fetchVersion;

  // Already cached and current version
  const cached = cache.get(pageIndex);
  if (cached && cached.version === version) {
    return cached.rows;
  }

  // Already fetching
  if (pendingFetches.has(pageIndex)) {
    return null; // will re-render when it arrives
  }

  const controller = new AbortController();
  pendingFetches.set(pageIndex, controller);

  try {
    const offset = pageIndex * FETCH_LIMIT;
    const data = await fetchLogs(offset, FETCH_LIMIT, version, controller.signal);

    pendingFetches.delete(pageIndex);

    // Stale response check
    if (version !== fetchVersion) {
      return null;
    }

    // Update total from response
    if (totalRows !== data.total) {
      totalRows = data.total;
      updateScrollHeight();
      updateRowCount();
    }

    cache.set(pageIndex, { rows: data.rows, version });
    render(); // re-render to show newly fetched data
    return data.rows;
  } catch (err) {
    pendingFetches.delete(pageIndex);
    if (err.name === 'AbortError') return null;
    console.error('[fetch] Error fetching page', pageIndex, err);
    return null;
  }
}

// ---- Rendering ----

function updateScrollHeight() {
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateRowCount() {
  if (currentSeverity || currentQuery) {
    rowCountEl.textContent = `${totalRows.toLocaleString()} filtered logs`;
  } else {
    rowCountEl.textContent = `${totalRows.toLocaleString()} total logs`;
  }
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return row;
}

// Pool of row elements
const rowPool = [];
const activeRows = new Map(); // rowIndex -> element

function getRowFromPool() {
  if (rowPool.length > 0) {
    return rowPool.pop();
  }
  return createRowElement();
}

function returnRowToPool(el) {
  el.style.transform = '';
  rowPool.push(el);
}

function render() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  if (totalRows === 0) {
    // Clear all active rows
    for (const [, el] of activeRows) {
      rowContainer.removeChild(el);
      returnRowToPool(el);
    }
    activeRows.clear();
    return;
  }

  // Calculate visible range
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastVisible = Math.min(
    totalRows - 1,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
  );

  // Determine which pages we need
  const neededPages = new Set();
  for (let i = firstVisible; i <= lastVisible; i++) {
    neededPages.add(getPageIndex(i));
  }

  // Remove rows outside visible range
  for (const [idx, el] of activeRows) {
    if (idx < firstVisible || idx > lastVisible) {
      rowContainer.removeChild(el);
      returnRowToPool(el);
      activeRows.delete(idx);
    }
  }

  // Request needed pages
  for (const pageIdx of neededPages) {
    ensurePage(pageIdx); // fire and forget, will re-render when data arrives
  }

  // Render visible rows
  for (let i = firstVisible; i <= lastVisible; i++) {
    const pageIndex = getPageIndex(i);
    const cached = cache.get(pageIndex);

    if (!cached || cached.version !== fetchVersion) {
      // Remove stale row if exists
      if (activeRows.has(i)) {
        const el = activeRows.get(i);
        rowContainer.removeChild(el);
        returnRowToPool(el);
        activeRows.delete(i);
      }
      continue;
    }

    const rowInPage = i - pageIndex * FETCH_LIMIT;
    const rowData = cached.rows[rowInPage];

    if (!rowData) {
      // Beyond data in this page (e.g. last page has fewer rows)
      if (activeRows.has(i)) {
        const el = activeRows.get(i);
        rowContainer.removeChild(el);
        returnRowToPool(el);
        activeRows.delete(i);
      }
      continue;
    }

    let el = activeRows.get(i);
    if (!el) {
      el = getRowFromPool();
      activeRows.set(i, el);
      rowContainer.appendChild(el);
    }

    // Update position
    el.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    el.style.height = `${ROW_HEIGHT}px`;

    // Update content
    const cols = el.children;
    cols[0].textContent = formatTimestamp(rowData.ts);
    cols[1].textContent = rowData.severity;
    cols[1].className = `col col-severity severity-${rowData.severity}`;
    cols[2].textContent = rowData.service;
    cols[3].textContent = rowData.message;

    // Row accent
    el.className = `log-row${rowData.severity === 'error' ? ' row-error' : rowData.severity === 'warn' ? ' row-warn' : ''}`;
  }
}

// ---- Event handlers ----

let scrollRafId = null;
scroller.addEventListener('scroll', () => {
  if (scrollRafId) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    render();
  });
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = searchInput.value.trim();
    resetAndFetch();
  }, DEBOUNCE_MS);
});

severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  resetAndFetch();
});

function resetAndFetch() {
  fetchVersion++;
  invalidateCache();
  totalRows = 0;
  updateScrollHeight();
  scroller.scrollTop = 0;

  // Clear active rows
  for (const [, el] of activeRows) {
    rowContainer.removeChild(el);
    returnRowToPool(el);
  }
  activeRows.clear();

  // Fetch first page which will set totalRows
  ensurePage(0).then(() => {
    render();
  });
}

// ---- Init ----

async function init() {
  try {
    // Load stats for badges
    const stats = await fetchStats();
    badgesEl.innerHTML = ['debug', 'info', 'warn', 'error'].map(s => {
      const count = stats.severityCounts[s] || 0;
      return `<span class="badge badge-${s}">${s}: ${count.toLocaleString()}</span>`;
    }).join('');

    // Initial fetch
    totalRows = stats.total;
    updateScrollHeight();
    updateRowCount();
    render();
  } catch (err) {
    console.error('[init] Failed to initialize:', err);
    rowCountEl.textContent = 'Error loading data';
  }
}

init();
