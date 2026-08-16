/**
 * Log Explorer — Virtualized Frontend
 *
 * Architecture:
 * - Virtual scroller that only renders visible rows + overscan
 * - Row cache: fetched windows are cached keyed by aligned offset
 * - Cache is versioned; filter changes increment the version, invalidating stale data
 * - Debounced search to avoid flooding the API
 * - Request versioning to discard stale responses
 */

const ROW_HEIGHT = 36; // must match CSS --row-height
const OVERSCAN = 10;   // extra rows above/below viewport
const FETCH_WINDOW = 100; // rows per API fetch
const DEBOUNCE_MS = 250;
const API_BASE = '/api';

// ───────── State ─────────
const state = {
  total: 0,
  severity: '',
  q: '',
  cache: new Map(),       // windowStart -> { rows, version }
  cacheVersion: 0,        // incremented on filter change
  pendingFetches: new Set(), // window offsets currently being fetched
  stats: null,
};

// ───────── DOM refs ─────────
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowContainer = document.getElementById('row-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadgesEl = document.getElementById('severity-badges');

// ───────── Row element pool ─────────
// Detached elements ready to be re-used.
const rowPool = [];

function createRowEl() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-severity"></div>' +
    '<div class="col col-service"></div>' +
    '<div class="col col-message"></div>';
  return row;
}

function acquireRowEl() {
  if (rowPool.length > 0) return rowPool.pop();
  return createRowEl();
}

function releaseRowEl(el) {
  // Detach from DOM and stash for reuse
  if (el.parentNode) el.parentNode.removeChild(el);
  rowPool.push(el);
}

// ───────── API helpers ─────────

async function fetchLogs(offset, limit, severity, q) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const resp = await fetch(`${API_BASE}/logs?${params.toString()}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json(); // { total, rows }
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// ───────── Cache ─────────

function getCachedRow(globalIndex) {
  const windowStart = Math.floor(globalIndex / FETCH_WINDOW) * FETCH_WINDOW;
  const entry = state.cache.get(windowStart);
  if (!entry || entry.version !== state.cacheVersion) return undefined;
  const localIdx = globalIndex - windowStart;
  return localIdx < entry.rows.length ? entry.rows[localIdx] : null;
}

// ───────── Data fetching ─────────

function getNeededWindows(startRow, endRow) {
  const windows = [];
  const seen = new Set();
  for (let i = startRow; i < endRow; i++) {
    const ws = Math.floor(i / FETCH_WINDOW) * FETCH_WINDOW;
    if (seen.has(ws)) continue;
    seen.add(ws);
    const entry = state.cache.get(ws);
    if (entry && entry.version === state.cacheVersion) continue;
    if (state.pendingFetches.has(ws)) continue;
    windows.push(ws);
  }
  return windows;
}

function ensureData(startRow, endRow) {
  const windows = getNeededWindows(startRow, endRow);
  if (windows.length === 0) return;

  const versionAtRequest = state.cacheVersion;

  for (const ws of windows) {
    state.pendingFetches.add(ws);

    fetchLogs(ws, FETCH_WINDOW, state.severity, state.q)
      .then((data) => {
        state.pendingFetches.delete(ws);
        if (versionAtRequest !== state.cacheVersion) return; // stale

        state.cache.set(ws, { rows: data.rows, version: versionAtRequest });
        state.total = data.total;
        updateScrollHeight();
        renderVisibleRows();
        updateRowCount();
      })
      .catch((err) => {
        state.pendingFetches.delete(ws);
        console.error('Fetch error:', err);
      });
  }
}

// ───────── Rendering ─────────

// Map from row index -> { el, dataKey }
// dataKey is a quick identity to avoid redundant DOM updates
const activeRows = new Map();

function renderVisibleRows() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  if (viewportHeight === 0) return; // not laid out yet

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const startRow = Math.max(0, firstVisible - OVERSCAN);
  const endRow = Math.min(state.total, lastVisible + OVERSCAN);

  // Which indices should be on-screen?
  const needed = new Set();
  for (let i = startRow; i < endRow; i++) needed.add(i);

  // Recycle rows no longer needed
  for (const [idx, info] of activeRows) {
    if (!needed.has(idx)) {
      releaseRowEl(info.el);
      activeRows.delete(idx);
    }
  }

  // Create / update needed rows
  for (let i = startRow; i < endRow; i++) {
    const rowData = getCachedRow(i);
    // Build a simple identity key so we skip DOM writes when unchanged
    const dataKey = rowData ? rowData.id : null;

    let info = activeRows.get(i);
    if (info) {
      // Already mounted — reposition (position may change if total changed)
      info.el.style.top = `${i * ROW_HEIGHT}px`;
      // Skip content update if same data
      if (info.dataKey === dataKey && dataKey !== null) continue;
    } else {
      // Acquire element & mount
      const el = acquireRowEl();
      el.style.top = `${i * ROW_HEIGHT}px`;
      el.style.height = `${ROW_HEIGHT}px`;
      rowContainer.appendChild(el);
      info = { el, dataKey: null };
      activeRows.set(i, info);
    }

    // Populate content
    const cols = info.el.children;
    if (rowData) {
      const ts = new Date(rowData.ts);
      cols[0].textContent = formatTimestamp(ts);
      cols[1].textContent = rowData.severity;
      cols[1].className = `col col-severity severity-${rowData.severity}`;
      cols[2].textContent = rowData.service;
      cols[3].textContent = rowData.message;
      info.el.style.opacity = '1';
    } else {
      cols[0].textContent = '';
      cols[1].textContent = '···';
      cols[1].className = 'col col-severity';
      cols[2].textContent = '';
      cols[3].textContent = 'Loading…';
      info.el.style.opacity = '0.3';
    }
    info.dataKey = dataKey;
  }

  // Trigger fetches for any uncached windows
  ensureData(startRow, endRow);
}

function formatTimestamp(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
}

function updateScrollHeight() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateRowCount() {
  rowCountEl.textContent = `Showing ${activeRows.size} of ${state.total.toLocaleString()} entries`;
}

// ───────── Scroll handling ─────────

let scrollRAF = null;

function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderVisibleRows();
    updateRowCount();
  });
}

scroller.addEventListener('scroll', onScroll, { passive: true });

// ───────── Filter handling ─────────

function resetView() {
  state.cacheVersion++;
  state.cache.clear();
  state.pendingFetches.clear();
  state.total = 0;

  // Recycle all active rows
  for (const [, info] of activeRows) {
    releaseRowEl(info.el);
  }
  activeRows.clear();

  scroller.scrollTop = 0;
  updateScrollHeight();
}

async function applyFilters() {
  resetView();

  const versionAtRequest = state.cacheVersion;

  try {
    const data = await fetchLogs(0, FETCH_WINDOW, state.severity, state.q);
    if (versionAtRequest !== state.cacheVersion) return; // superseded

    state.total = data.total;
    state.cache.set(0, { rows: data.rows, version: versionAtRequest });
    updateScrollHeight();
    renderVisibleRows();
    updateRowCount();
  } catch (err) {
    console.error('Filter apply error:', err);
  }
}

// Severity change
severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  applyFilters();
});

// Search with debounce
let searchTimer = null;

searchInput.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    applyFilters();
  }, DEBOUNCE_MS);
});

// ───────── Stats / Badges ─────────

async function loadStats() {
  try {
    const stats = await fetchStats();
    state.stats = stats;

    severityBadgesEl.innerHTML = '';
    for (const sev of ['debug', 'info', 'warn', 'error']) {
      const badge = document.createElement('span');
      badge.className = `badge badge-${sev}`;
      badge.textContent = `${sev}: ${stats.severities[sev].toLocaleString()}`;
      severityBadgesEl.appendChild(badge);
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ───────── Init ─────────

async function init() {
  await loadStats();
  await applyFilters();
}

init();
