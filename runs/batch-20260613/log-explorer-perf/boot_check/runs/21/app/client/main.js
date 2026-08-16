const API_BASE = window.location.port === '5173' ? '' : 'http://localhost:3001';
const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_LIMIT = 100; // rows per fetch
const DEBOUNCE_MS = 250;

// State
let state = {
  total: 0,
  severity: '',
  query: '',
  rows: new Map(), // offset -> row data (cache)
  pendingFetches: new Set(), // page indices currently being fetched
  requestId: 0, // monotonically increasing to discard stale responses
  stats: null,
};

// DOM refs
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const container = document.getElementById('row-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// Pool of row DOM elements
let rowPool = [];

function createRowElement() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return el;
}

function formatTs(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function populateRow(el, row, offset) {
  const cols = el.children;
  cols[0].textContent = formatTs(row.ts);
  cols[1].textContent = row.severity.toUpperCase();
  cols[1].className = `col col-severity sev-${row.severity}`;
  cols[2].textContent = row.service;
  cols[3].textContent = row.message;
  el.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
  el.style.height = `${ROW_HEIGHT}px`;
}

function clearRowElement(el) {
  const cols = el.children;
  cols[0].textContent = '';
  cols[1].textContent = '';
  cols[1].className = 'col col-severity';
  cols[2].textContent = '';
  cols[3].textContent = '';
}

async function fetchLogs(offset, limit, requestId) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  if (state.severity) params.set('severity', state.severity);
  if (state.query) params.set('q', state.query);

  const res = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();

  // Discard if stale
  if (requestId !== state.requestId) return null;

  return data;
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) return;
    state.stats = await res.json();
    renderBadges();
  } catch (e) {
    console.error('Failed to fetch stats:', e);
  }
}

function renderBadges() {
  if (!state.stats) return;
  const counts = state.stats.severityCounts;
  badgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
    .map(s => `<span class="badge badge-${s}">${s}: ${(counts[s] || 0).toLocaleString()}</span>`)
    .join('');
}

function updateRowCount() {
  const visible = container.querySelectorAll('.log-row').length;
  rowCountEl.textContent = `${visible} of ${state.total.toLocaleString()} logs`;
}

// Determine which "pages" (blocks of FETCH_LIMIT) are needed
function getVisibleRange() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const startRow = Math.max(0, firstVisible - OVERSCAN);
  const endRow = Math.min(state.total - 1, lastVisible + OVERSCAN);

  return { startRow, endRow };
}

// Page index for a given row offset
function pageForRow(row) {
  return Math.floor(row / FETCH_LIMIT);
}

async function ensureData(startRow, endRow) {
  const startPage = pageForRow(startRow);
  const endPage = pageForRow(endRow);
  const requestId = state.requestId;

  const promises = [];

  for (let page = startPage; page <= endPage; page++) {
    const pageOffset = page * FETCH_LIMIT;
    // Check if we have data for this page
    if (state.rows.has(page) || state.pendingFetches.has(page)) continue;

    state.pendingFetches.add(page);
    const p = fetchLogs(pageOffset, FETCH_LIMIT, requestId)
      .then(data => {
        state.pendingFetches.delete(page);
        if (!data) return; // stale
        // Store rows indexed by their absolute offset
        const pageRows = new Map();
        data.rows.forEach((row, i) => {
          pageRows.set(pageOffset + i, row);
        });
        state.rows.set(page, pageRows);
        // Update total if needed
        if (data.total !== state.total) {
          state.total = data.total;
          spacer.style.height = `${state.total * ROW_HEIGHT}px`;
          updateRowCount();
        }
      })
      .catch(err => {
        state.pendingFetches.delete(page);
        console.error('Fetch error:', err);
      });
    promises.push(p);
  }

  if (promises.length > 0) {
    await Promise.all(promises);
    if (requestId === state.requestId) {
      renderRows();
    }
  }
}

function renderRows() {
  const { startRow, endRow } = getVisibleRange();
  if (state.total === 0) {
    container.innerHTML = '';
    updateRowCount();
    return;
  }

  const neededCount = endRow - startRow + 1;

  // Ensure pool has enough elements
  while (rowPool.length < neededCount) {
    const el = createRowElement();
    rowPool.push(el);
  }

  // Detach all existing children
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  let attached = 0;
  for (let offset = startRow; offset <= endRow; offset++) {
    const page = pageForRow(offset);
    const pageData = state.rows.get(page);
    const row = pageData ? pageData.get(offset) : null;

    const el = rowPool[attached];
    if (row) {
      populateRow(el, row, offset);
      container.appendChild(el);
      attached++;
    } else {
      // Show placeholder
      clearRowElement(el);
      el.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
      el.style.height = `${ROW_HEIGHT}px`;
      container.appendChild(el);
      attached++;
    }
  }

  updateRowCount();
}

function resetAndFetch() {
  // Increment requestId to invalidate in-flight requests
  state.requestId++;
  state.rows.clear();
  state.pendingFetches.clear();

  // First fetch to get total
  const requestId = state.requestId;
  fetchLogs(0, FETCH_LIMIT, requestId).then(data => {
    if (!data) return; // stale
    state.total = data.total;
    spacer.style.height = `${state.total * ROW_HEIGHT}px`;

    const pageRows = new Map();
    data.rows.forEach((row, i) => {
      pageRows.set(i, row);
    });
    state.rows.set(0, pageRows);

    scroller.scrollTop = 0;
    renderRows();
  }).catch(err => {
    console.error('Initial fetch error:', err);
  });
}

// Scroll handler with requestAnimationFrame throttle
let scrollRaf = null;
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    const { startRow, endRow } = getVisibleRange();
    renderRows();
    ensureData(startRow, endRow);
  });
}

// Debounce helper
function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

// Event handlers
scroller.addEventListener('scroll', onScroll, { passive: true });

severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndFetch();
});

const debouncedSearch = debounce(() => {
  state.query = searchInput.value.trim();
  resetAndFetch();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

// Initial load
async function init() {
  await fetchStats();
  resetAndFetch();
}

init();
