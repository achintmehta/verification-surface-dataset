/**
 * Log Explorer - Virtualized Frontend
 *
 * Architecture:
 * - Virtual scroller: only visible rows + overscan exist in DOM
 * - Scroll position → row offset → fetch window from API
 * - Debounced search, stale-response cancellation via request ID
 * - Severity color coding, row count display
 */

const API_BASE = 'http://localhost:3001/api';
const ROW_HEIGHT = 36;          // px, must match CSS --row-height
const WINDOW_SIZE = 100;        // rows fetched per request
const OVERSCAN = 10;            // extra rows above/below viewport
const DEBOUNCE_MS = 250;        // search debounce delay
const SCROLL_DEBOUNCE_MS = 50;  // scroll handler debounce

// ===== State =====
const state = {
  total: 0,
  severity: '',
  q: '',
  rows: [],           // currently fetched rows
  fetchOffset: 0,     // offset of first row in `rows`
  requestId: 0,       // monotonically increasing, for stale-response detection
  pendingRequests: 0,
};

// ===== DOM References =====
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer    = document.getElementById('scroll-spacer');
const rowsContainer   = document.getElementById('rows-container');
const rowCountEl      = document.getElementById('row-count');
const statsBadgesEl   = document.getElementById('stats-badges');
const severitySelect  = document.getElementById('severity-select');
const searchInput     = document.getElementById('search-input');
const loadingOverlay  = document.getElementById('loading-overlay');

// ===== Utility =====
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatTs(tsStr) {
  // Format: 2024-01-15 14:32:07.123
  const d = new Date(tsStr);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
         `.${pad(d.getUTCMilliseconds(), 3)}`;
}

function setLoading(active) {
  if (active) {
    loadingOverlay.classList.remove('hidden');
  } else {
    loadingOverlay.classList.add('hidden');
  }
}

// ===== API =====
async function fetchLogs(offset, limit, severity, q, reqId) {
  const params = new URLSearchParams({ offset, limit });
  if (severity) params.set('severity', severity);
  if (q)        params.set('q', q);

  const url = `${API_BASE}/logs?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error(`Stats API error ${res.status}`);
  return res.json();
}

// ===== Stats / Badges =====
async function loadStats() {
  try {
    const stats = await fetchStats();
    statsBadgesEl.innerHTML = `
      <span class="badge badge-debug">D ${stats.bySeverity.debug.toLocaleString()}</span>
      <span class="badge badge-info">I ${stats.bySeverity.info.toLocaleString()}</span>
      <span class="badge badge-warn">W ${stats.bySeverity.warn.toLocaleString()}</span>
      <span class="badge badge-error">E ${stats.bySeverity.error.toLocaleString()}</span>
    `;
  } catch (e) {
    console.warn('Failed to load stats:', e);
  }
}

// ===== Row Rendering =====
function createRowEl(row) {
  const el = document.createElement('div');
  el.className = `log-row severity-${row.severity}`;
  el.style.height = `${ROW_HEIGHT}px`;
  el.innerHTML = `
    <div class="col col-ts">${formatTs(row.ts)}</div>
    <div class="col col-severity">${row.severity}</div>
    <div class="col col-service">${escapeHtml(row.service)}</div>
    <div class="col col-message">${escapeHtml(row.message)}</div>
  `;
  return el;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Virtual Scroller =====
function getViewportInfo() {
  const scrollTop = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;
  return { scrollTop, viewportHeight };
}

function getVisibleRange(scrollTop, viewportHeight) {
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible  = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  const start = Math.max(0, firstVisible - OVERSCAN);
  const end   = Math.min(state.total - 1, lastVisible + OVERSCAN);
  return { start, end };
}

/**
 * Determine what window to fetch given the visible range.
 * We fetch WINDOW_SIZE rows centered around the visible range.
 */
function computeFetchWindow(start, end) {
  const needed = end - start + 1;
  const fetchSize = Math.max(WINDOW_SIZE, needed + OVERSCAN * 2);
  const cappedSize = Math.min(fetchSize, WINDOW_SIZE); // cap at API max
  // Center the window around the visible range
  let fetchOffset = Math.max(0, start - OVERSCAN);
  fetchOffset = Math.min(fetchOffset, Math.max(0, state.total - cappedSize));
  return { fetchOffset, fetchSize: Math.min(WINDOW_SIZE, state.total - fetchOffset) };
}

/**
 * Check if the current cached rows cover the visible range.
 */
function cacheCoversRange(start, end) {
  if (state.rows.length === 0) return false;
  const cacheStart = state.fetchOffset;
  const cacheEnd   = state.fetchOffset + state.rows.length - 1;
  return cacheStart <= start && cacheEnd >= end;
}

let currentRender = null; // tracks the last render call

async function renderViewport() {
  const { scrollTop, viewportHeight } = getViewportInfo();
  const { start, end } = getVisibleRange(scrollTop, viewportHeight);

  if (state.total === 0) {
    rowsContainer.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <p>No log entries match your filters.</p>
      </div>
    `;
    rowsContainer.style.transform = '';
    return;
  }

  // If cache doesn't cover the visible range, fetch
  if (!cacheCoversRange(start, end)) {
    const { fetchOffset, fetchSize } = computeFetchWindow(start, end);
    const reqId = ++state.requestId;
    state.pendingRequests++;
    setLoading(true);

    try {
      const data = await fetchLogs(
        fetchOffset,
        fetchSize,
        state.severity,
        state.q,
        reqId
      );

      // Stale response check
      if (reqId !== state.requestId) return;

      state.rows = data.rows;
      state.fetchOffset = fetchOffset;
      // Update total in case it changed (shouldn't, but defensive)
      if (data.total !== state.total) {
        state.total = data.total;
        updateScrollHeight();
        updateRowCount();
      }
    } catch (e) {
      if (reqId !== state.requestId) return;
      console.error('Failed to fetch logs:', e);
    } finally {
      state.pendingRequests--;
      if (state.pendingRequests === 0) setLoading(false);
    }
  }

  // Render rows from cache
  paintRows(start, end);
}

function paintRows(start, end) {
  // Clamp to available cache
  const cacheStart = state.fetchOffset;
  const cacheEnd   = state.fetchOffset + state.rows.length - 1;
  const renderStart = Math.max(start, cacheStart);
  const renderEnd   = Math.min(end, cacheEnd);

  if (renderStart > renderEnd) {
    rowsContainer.innerHTML = '';
    return;
  }

  // Reuse existing DOM nodes where possible
  const existingRows = rowsContainer.querySelectorAll('.log-row');
  const existingCount = existingRows.length;
  const neededCount = renderEnd - renderStart + 1;

  // Remove excess rows
  for (let i = existingCount - 1; i >= neededCount; i--) {
    existingRows[i].remove();
  }

  // Update or create rows
  for (let i = 0; i < neededCount; i++) {
    const rowIndex = renderStart + i;
    const cacheIndex = rowIndex - state.fetchOffset;
    const row = state.rows[cacheIndex];
    if (!row) continue;

    if (i < existingCount) {
      // Update existing row
      const el = existingRows[i];
      updateRowEl(el, row);
    } else {
      // Create new row
      const el = createRowEl(row);
      rowsContainer.appendChild(el);
    }
  }

  // Position the rows container at the correct vertical offset
  const topOffset = renderStart * ROW_HEIGHT;
  rowsContainer.style.transform = `translateY(${topOffset}px)`;
}

function updateRowEl(el, row) {
  // Only update if data changed (check by a data attribute)
  const prevId = el.dataset.rowId;
  if (prevId === String(row.id)) return; // same row, skip

  el.dataset.rowId = row.id;
  el.className = `log-row severity-${row.severity}`;
  el.children[0].textContent = formatTs(row.ts);
  el.children[1].textContent = row.severity;
  el.children[2].textContent = row.service;
  el.children[3].textContent = row.message;
}

// ===== Scroll Height =====
function updateScrollHeight() {
  const totalHeight = state.total * ROW_HEIGHT;
  scrollSpacer.style.height = `${totalHeight}px`;
}

// ===== Row Count Display =====
function updateRowCount() {
  const filterActive = state.severity || state.q;
  if (filterActive) {
    rowCountEl.innerHTML = `<strong>${state.total.toLocaleString()}</strong> of 100,000 rows`;
  } else {
    rowCountEl.innerHTML = `<strong>${state.total.toLocaleString()}</strong> rows`;
  }
}

// ===== Initial Load =====
async function initialLoad() {
  const reqId = ++state.requestId;
  state.pendingRequests++;
  setLoading(true);

  try {
    const data = await fetchLogs(0, WINDOW_SIZE, state.severity, state.q, reqId);
    if (reqId !== state.requestId) return;

    state.total = data.total;
    state.rows = data.rows;
    state.fetchOffset = 0;

    updateScrollHeight();
    updateRowCount();
    paintRows(0, Math.min(WINDOW_SIZE - 1, state.total - 1));
  } catch (e) {
    console.error('Initial load failed:', e);
    rowCountEl.textContent = 'Error loading logs';
  } finally {
    state.pendingRequests--;
    if (state.pendingRequests === 0) setLoading(false);
  }
}

// ===== Filter Change =====
async function applyFilters() {
  // Reset scroll position
  scrollContainer.scrollTop = 0;

  // Invalidate cache
  state.rows = [];
  state.fetchOffset = 0;
  state.total = 0;

  // Clear rows
  rowsContainer.innerHTML = '';
  updateScrollHeight();

  await initialLoad();
}

// ===== Scroll Handler =====
const onScroll = debounce(() => {
  renderViewport();
}, SCROLL_DEBOUNCE_MS);

// ===== Event Listeners =====
scrollContainer.addEventListener('scroll', onScroll, { passive: true });

severitySelect.addEventListener('change', () => {
  state.severity = severitySelect.value;
  applyFilters();
});

const debouncedSearch = debounce(() => {
  state.q = searchInput.value.trim();
  applyFilters();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

// ===== Boot =====
(async () => {
  await Promise.all([
    initialLoad(),
    loadStats(),
  ]);
})();
