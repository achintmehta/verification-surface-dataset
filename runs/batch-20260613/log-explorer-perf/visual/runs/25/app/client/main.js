const API_BASE = '/api';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FETCH_LIMIT = 100;
const DEBOUNCE_MS = 250;

// State
let state = {
  total: 0,
  severity: '',
  query: '',
  cache: new Map(), // page index -> { rows, fetchedAt }
  requestId: 0,     // monotonic ID to discard stale responses
  stats: null,
};

// DOM references
const scroller = document.getElementById('virtual-scroller');
const scrollContent = document.getElementById('scroll-content');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statusText = document.getElementById('status-text');
const badgesContainer = document.getElementById('severity-badges');

// Track visible row elements for recycling
let visibleRowEls = [];

// ---- API ----

async function fetchLogs(offset, limit, requestId) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  if (state.severity) params.set('severity', state.severity);
  if (state.query) params.set('q', state.query);

  const response = await fetch(`${API_BASE}/logs?${params}`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return { data: await response.json(), requestId };
}

async function fetchStats() {
  const response = await fetch(`${API_BASE}/stats`);
  if (!response.ok) throw new Error(`Stats API error: ${response.status}`);
  return response.json();
}

// ---- Rendering ----

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
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

function updateRowElement(el, row, topPx) {
  el.style.top = `${topPx}px`;

  const cols = el.children;
  cols[0].textContent = formatTimestamp(row.ts);

  const badge = document.createElement('span');
  badge.className = `severity-badge severity-${row.severity}`;
  badge.textContent = row.severity;
  cols[1].textContent = '';
  cols[1].appendChild(badge);

  cols[2].textContent = row.service;
  cols[3].textContent = row.message;

  el.dataset.rowIndex = row._virtualIndex;
}

function setLoadingRow(el, topPx, index) {
  el.style.top = `${topPx}px`;
  const cols = el.children;
  cols[0].textContent = '';
  cols[1].textContent = '';
  cols[2].textContent = '';
  cols[3].textContent = 'Loading...';
  cols[3].style.fontStyle = 'italic';
  cols[3].style.color = 'var(--text-muted)';
  el.dataset.rowIndex = index;
}

// ---- Virtual Scroller ----

function getVisibleRange() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const start = Math.max(0, firstVisible - OVERSCAN);
  const end = Math.min(state.total, lastVisible + OVERSCAN);

  return { start, end };
}

function getPageIndex(rowIndex) {
  return Math.floor(rowIndex / FETCH_LIMIT);
}

function getRowFromCache(rowIndex) {
  const pageIdx = getPageIndex(rowIndex);
  const page = state.cache.get(pageIdx);
  if (!page) return null;
  const offsetInPage = rowIndex - pageIdx * FETCH_LIMIT;
  return page.rows[offsetInPage] || null;
}

// Pages currently being fetched
const fetchingPages = new Set();

function fetchPageIfNeeded(pageIdx) {
  if (state.cache.has(pageIdx) || fetchingPages.has(pageIdx)) return;

  fetchingPages.add(pageIdx);
  const offset = pageIdx * FETCH_LIMIT;
  const currentRequestId = state.requestId;

  fetchLogs(offset, FETCH_LIMIT, currentRequestId)
    .then(({ data, requestId }) => {
      fetchingPages.delete(pageIdx);
      // Discard if stale (filters changed since this request was made)
      if (requestId !== state.requestId) return;

      // Update total from server
      state.total = data.total;

      // Store in cache
      state.cache.set(pageIdx, {
        rows: data.rows,
        fetchedAt: Date.now(),
      });

      // Re-render
      render();
    })
    .catch((err) => {
      fetchingPages.delete(pageIdx);
      console.error('Fetch error:', err);
    });
}

function render() {
  // Update scroll content height
  const totalHeight = state.total * ROW_HEIGHT;
  scrollContent.style.height = `${totalHeight}px`;

  // Update row count display
  updateRowCount();

  if (state.total === 0) {
    // Clear all rows
    rowsContainer.innerHTML = '';
    visibleRowEls = [];
    statusText.textContent = 'No logs match the current filters';
    return;
  }

  const { start, end } = getVisibleRange();
  const needed = end - start;

  // Determine which pages we need
  const startPage = getPageIndex(start);
  const endPage = getPageIndex(Math.max(0, end - 1));
  for (let p = startPage; p <= endPage; p++) {
    fetchPageIfNeeded(p);
  }

  // Ensure we have enough row elements
  while (visibleRowEls.length < needed) {
    const el = createRowElement();
    rowsContainer.appendChild(el);
    visibleRowEls.push(el);
  }

  // Remove excess elements beyond a reasonable cap
  const MAX_POOL = 80;
  while (visibleRowEls.length > Math.max(needed, MAX_POOL)) {
    const el = visibleRowEls.pop();
    el.remove();
  }

  // Hide excess elements
  for (let i = needed; i < visibleRowEls.length; i++) {
    visibleRowEls[i].style.display = 'none';
  }

  // Update visible rows
  for (let i = 0; i < needed; i++) {
    const rowIndex = start + i;
    const el = visibleRowEls[i];
    el.style.display = '';

    const row = getRowFromCache(rowIndex);
    const topPx = rowIndex * ROW_HEIGHT;

    if (row) {
      row._virtualIndex = rowIndex;
      // Reset any loading styles
      const msgCol = el.children[3];
      msgCol.style.fontStyle = '';
      msgCol.style.color = '';
      updateRowElement(el, row, topPx);
    } else {
      setLoadingRow(el, topPx, rowIndex);
    }
  }

  statusText.textContent = `Showing rows ${start + 1}–${Math.min(end, state.total)} of ${state.total.toLocaleString()} total`;
}

// ---- Event Handlers ----

let scrollRAF = null;
scroller.addEventListener('scroll', () => {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    render();
  });
});

// Severity filter
severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndRefetch();
});

// Debounced search
let searchTimeout = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.query = searchInput.value.trim();
    resetAndRefetch();
  }, DEBOUNCE_MS);
});

function resetAndRefetch() {
  // Increment request ID to invalidate all in-flight requests
  state.requestId++;
  state.cache.clear();
  fetchingPages.clear();
  state.total = 0;

  // Reset scroll position
  scroller.scrollTop = 0;

  // Clear visible rows
  rowsContainer.innerHTML = '';
  visibleRowEls = [];

  // Fetch first page to get total
  const currentRequestId = state.requestId;
  fetchLogs(0, FETCH_LIMIT, currentRequestId)
    .then(({ data, requestId }) => {
      if (requestId !== state.requestId) return;

      state.total = data.total;
      state.cache.set(0, { rows: data.rows, fetchedAt: Date.now() });
      render();
    })
    .catch((err) => {
      console.error('Fetch error:', err);
      statusText.textContent = 'Error loading logs';
    });
}

function updateRowCount() {
  if (state.total === 0 && !state.severity && !state.query) {
    rowCountEl.textContent = 'Loading...';
  } else {
    const filtered = state.severity || state.query;
    if (filtered && state.stats) {
      rowCountEl.textContent = `${state.total.toLocaleString()} of ${state.stats.total.toLocaleString()} logs`;
    } else {
      rowCountEl.textContent = `${state.total.toLocaleString()} logs`;
    }
  }
}

async function loadStats() {
  try {
    state.stats = await fetchStats();
    renderBadges();
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function renderBadges() {
  if (!state.stats) return;
  const { severities } = state.stats;
  badgesContainer.innerHTML = `
    <span class="badge badge-debug">D: ${severities.debug.toLocaleString()}</span>
    <span class="badge badge-info">I: ${severities.info.toLocaleString()}</span>
    <span class="badge badge-warn">W: ${severities.warn.toLocaleString()}</span>
    <span class="badge badge-error">E: ${severities.error.toLocaleString()}</span>
  `;
}

// ---- Init ----

async function init() {
  statusText.textContent = 'Connecting to server...';

  // Wait for server to be ready
  let ready = false;
  let attempts = 0;
  while (!ready && attempts < 120) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      const data = await res.json();
      if (data.status === 'ready') {
        ready = true;
      } else {
        statusText.textContent = 'Server initializing (seeding database)...';
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      statusText.textContent = `Waiting for server... (attempt ${++attempts})`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    attempts++;
  }

  if (!ready) {
    statusText.textContent = 'Failed to connect to server';
    return;
  }

  statusText.textContent = 'Loading...';

  // Load stats and initial data
  await loadStats();
  resetAndRefetch();
}

init();
