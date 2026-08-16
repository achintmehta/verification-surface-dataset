const ROW_HEIGHT = 32;
const OVERSCAN = 12;        // rows above/below viewport
const PAGE = 200;           // server window size (max allowed)
const DEBOUNCE_MS = 220;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');

// ---- state ----
let total = 0;
let filters = { severity: '', q: '' };
// Cache of fetched pages: pageIndex -> array of row objects.
const pageCache = new Map();
// Which pages are currently in flight.
const inflight = new Set();
// Monotonic token so stale responses never win.
let filterToken = 0;
// Pool of recycled DOM row elements.
const rowPool = [];
let emptyEl = null;

function sevBadge(sev) {
  return `<span class="sev-badge sev-${sev}">${sev}</span>`;
}

function fmtTs(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- data fetching ----
async function fetchStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) return;
  const data = await res.json();
  // initial total set from stats (unfiltered)
  return data;
}

function buildQuery(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);
  return `/api/logs?${params.toString()}`;
}

// Fetch a page (by page index) for the current filter token.
async function fetchPage(pageIndex, token) {
  if (token !== filterToken) return;
  if (pageCache.has(pageIndex) || inflight.has(pageIndex)) return;
  inflight.add(pageIndex);
  const offset = pageIndex * PAGE;
  try {
    const res = await fetch(buildQuery(offset, PAGE));
    if (token !== filterToken) return; // stale
    if (!res.ok) return;
    const data = await res.json();
    if (token !== filterToken) return; // stale
    total = data.total;
    pageCache.set(pageIndex, data.rows);
    updateCount();
    updateSpacer();
    render();
  } catch (e) {
    // network error: allow retry later
  } finally {
    inflight.delete(pageIndex);
  }
}

// ---- rendering (virtualized) ----
function updateSpacer() {
  spacer.style.height = Math.max(total * ROW_HEIGHT, 0) + 'px';
}

let grandTotal = 0;
function updateCount() {
  countEl.textContent = `${total.toLocaleString()} of ${(grandTotal || total).toLocaleString()}`;
}

function getRowEl() {
  return rowPool.pop() || createRowEl();
}

function createRowEl() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-sev"></div>' +
    '<div class="col col-svc"></div>' +
    '<div class="col col-msg"></div>';
  return el;
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewH = viewport.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewH / ROW_HEIGHT);

  let start = Math.max(0, firstVisible - OVERSCAN);
  let end = Math.min(total, firstVisible + visibleCount + OVERSCAN);

  // Ensure pages covering [start, end) are loaded.
  const firstPage = Math.floor(start / PAGE);
  const lastPage = Math.floor(Math.max(start, end - 1) / PAGE);
  for (let pi = firstPage; pi <= lastPage; pi++) {
    if (!pageCache.has(pi) && !inflight.has(pi)) {
      fetchPage(pi, filterToken);
    }
  }

  // Recycle all current row elements.
  while (rowsEl.firstChild) {
    const child = rowsEl.firstChild;
    rowsEl.removeChild(child);
    if (child.classList && child.classList.contains('log-row')) {
      rowPool.push(child);
    }
  }

  // Only declare "empty" once page 0 has actually resolved for this filter,
  // otherwise we'd flash the empty state before the first response arrives.
  if (total === 0 && pageCache.has(0)) {
    showEmpty(true);
    return;
  }
  showEmpty(false);
  if (total === 0) return;

  for (let i = start; i < end; i++) {
    const pi = Math.floor(i / PAGE);
    const page = pageCache.get(pi);
    const row = page ? page[i - pi * PAGE] : null;
    const el = getRowEl();
    el.style.top = i * ROW_HEIGHT + 'px';
    const [tsEl, sevEl, svcEl, msgEl] = el.children;
    if (row) {
      tsEl.textContent = fmtTs(row.ts);
      sevEl.innerHTML = sevBadge(row.severity);
      svcEl.textContent = row.service;
      msgEl.textContent = row.message;
    } else {
      tsEl.textContent = '';
      sevEl.innerHTML = '';
      svcEl.textContent = '';
      msgEl.textContent = '…';
    }
    rowsEl.appendChild(el);
  }
}

function showEmpty(on) {
  if (on) {
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'empty';
      emptyEl.textContent = 'No log entries match the current filters.';
      viewport.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
    emptyEl = null;
  }
}

// ---- filter changes ----
function resetForNewFilter() {
  filterToken++;
  pageCache.clear();
  inflight.clear();
  total = 0;
  viewport.scrollTop = 0;
  updateSpacer();
  updateCount();
  render();
  // Kick off first page immediately.
  fetchPage(0, filterToken);
}

let debounceTimer = null;
function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    filters.q = searchInput.value.trim();
    resetForNewFilter();
  }, DEBOUNCE_MS);
}

function onSeverityChange() {
  filters.severity = severitySel.value;
  resetForNewFilter();
}

// ---- scroll (throttled with rAF) ----
let scrollScheduled = false;
function onScroll() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    render();
  });
}

viewport.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', () => render());
searchInput.addEventListener('input', onSearchInput);
severitySel.addEventListener('change', onSeverityChange);

// ---- boot ----
async function boot() {
  try {
    const stats = await fetchStats();
    if (stats) {
      grandTotal = stats.total;
    }
  } catch (e) {
    /* ignore */
  }
  resetForNewFilter();
}

boot();
