// Virtualized log explorer client.
//
// Design:
// - The scroller has a spacer element whose height equals total * ROW_HEIGHT,
//   so the native scrollbar reflects the full (filtered) corpus size.
// - Only the rows intersecting the viewport (plus overscan) are materialized
//   in the DOM. Rows are positioned absolutely via a translated viewport.
// - As the user scrolls, we compute the visible offset range and fetch the
//   required window (max 200 rows per request). Windows are cached; scrolling
//   recycles DOM nodes.
// - Filters (severity + debounced search) reset scroll, refetch total, and
//   invalidate the cache. Every fetch carries a monotonically increasing
//   request generation so stale responses never overwrite newer results.

const ROW_HEIGHT = 28;
const OVERSCAN = 12; // rows above/below viewport
const PAGE = 200; // server max limit; also our fetch window size
const DEBOUNCE_MS = 180;

const scroller = document.getElementById('scroller');
const spacer = document.getElementById('spacer');
const viewport = document.getElementById('viewport');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');
const badgesEl = document.getElementById('badges');

const state = {
  total: 0, // filtered total
  corpusTotal: 0, // unfiltered corpus total (from /api/stats)
  filter: { severity: '', q: '' },
  // page cache: pageIndex -> array of row objects (length up to PAGE)
  pages: new Map(),
  // pageIndex -> true while a fetch is in flight
  pending: new Map(),
  // generation counter: bumped whenever the filter changes. Responses from an
  // older generation are discarded.
  generation: 0,
};

// Pool of reusable row DOM nodes keyed by their absolute row index.
const rowNodes = new Map(); // rowIndex -> element

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function pageIndexFor(rowIndex) {
  return Math.floor(rowIndex / PAGE);
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    state.corpusTotal = data.total ?? 0;
    renderBadges(data.bySeverity);
    updateCount();
  } catch (e) {
    // stats are cosmetic; ignore failures
  }
}

function renderBadges(bySeverity) {
  badgesEl.innerHTML = '';
  for (const sev of ['debug', 'info', 'warn', 'error']) {
    const b = document.createElement('span');
    b.className = `badge ${sev}`;
    b.textContent = `${sev} ${formatNum(bySeverity?.[sev] ?? 0)}`;
    b.dataset.sev = sev;
    b.addEventListener('click', () => {
      // toggle severity filter via badge
      severitySel.value = severitySel.value === sev ? '' : sev;
      severitySel.dispatchEvent(new Event('change'));
    });
    badgesEl.appendChild(b);
  }
  syncBadgeActive();
}

function syncBadgeActive() {
  for (const b of badgesEl.querySelectorAll('.badge')) {
    b.classList.toggle('active', b.dataset.sev === state.filter.severity);
  }
}

function buildQuery(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.filter.severity) params.set('severity', state.filter.severity);
  if (state.filter.q) params.set('q', state.filter.q);
  return params.toString();
}

// Fetch the total (and first window) for the current filter.
async function refreshTotal() {
  const gen = state.generation;
  try {
    const res = await fetch('/api/logs?' + buildQuery(0, PAGE));
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    if (gen !== state.generation) return; // stale
    state.total = data.total;
    state.pages.set(0, data.rows);
    updateSpacer();
    updateCount();
    render();
  } catch (e) {
    if (gen !== state.generation) return;
    state.total = 0;
    updateSpacer();
    updateCount();
    render();
  }
}

async function ensurePage(pageIndex) {
  if (state.pages.has(pageIndex) || state.pending.has(pageIndex)) return;
  const gen = state.generation;
  state.pending.set(pageIndex, true);
  const offset = pageIndex * PAGE;
  try {
    const res = await fetch('/api/logs?' + buildQuery(offset, PAGE));
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    if (gen !== state.generation) return; // stale — discard
    state.pages.set(pageIndex, data.rows);
    // total should be stable within a generation, but keep it fresh
    if (typeof data.total === 'number') state.total = data.total;
    render();
  } catch (e) {
    // leave it unset; a later scroll pass will retry
  } finally {
    if (gen === state.generation) state.pending.delete(pageIndex);
  }
}

function getRow(rowIndex) {
  const pi = pageIndexFor(rowIndex);
  const page = state.pages.get(pi);
  if (!page) return undefined;
  return page[rowIndex - pi * PAGE];
}

// ---------------------------------------------------------------------------
// Rendering / virtualization
// ---------------------------------------------------------------------------

function updateSpacer() {
  spacer.style.height = Math.max(1, state.total * ROW_HEIGHT) + 'px';
}

function updateCount() {
  // "N of <total>": N is the filtered result count, <total> is the corpus size.
  const denom = state.corpusTotal || state.total;
  countEl.textContent = `${formatNum(state.total)} of ${formatNum(denom)}`;
}

function formatNum(n) {
  return Number(n).toLocaleString('en-US');
}

function visibleRange() {
  const scrollTop = scroller.scrollTop;
  const height = scroller.clientHeight;
  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(height / ROW_HEIGHT);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(state.total, first + visibleCount + OVERSCAN);
  return { start, end };
}

function render() {
  const { start, end } = visibleRange();

  // Determine which pages we need and kick off fetches.
  if (state.total > 0) {
    const firstPage = pageIndexFor(start);
    const lastPage = pageIndexFor(Math.max(start, end - 1));
    for (let pi = firstPage; pi <= lastPage; pi++) {
      ensurePage(pi);
    }
  }

  // Recycle: remove nodes now out of range.
  for (const [idx, node] of rowNodes) {
    if (idx < start || idx >= end) {
      node.remove();
      rowNodes.delete(idx);
    }
  }

  // Create / update nodes in range.
  for (let i = start; i < end; i++) {
    let node = rowNodes.get(i);
    if (!node) {
      node = document.createElement('div');
      rowNodes.set(i, node);
      viewport.appendChild(node);
    }
    positionAndFill(node, i);
  }
}

function positionAndFill(node, rowIndex) {
  node.style.position = 'absolute';
  node.style.top = rowIndex * ROW_HEIGHT + 'px';
  node.style.left = '0';
  node.style.right = '0';

  const row = getRow(rowIndex);
  if (!row) {
    node.className = 'log-row loading';
    node.innerHTML =
      '<span class="col-ts">…</span><span class="col-sev"></span>' +
      '<span class="col-svc"></span><span class="col-msg">loading…</span>';
    return;
  }

  node.className = `log-row sev-${row.severity}`;
  node.innerHTML = '';
  node.appendChild(cell('col-ts', formatTs(row.ts)));
  node.appendChild(cell('col-sev', row.severity));
  node.appendChild(cell('col-svc', row.service));
  node.appendChild(cell('col-msg', row.message));
}

function cell(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  s.title = text;
  return s;
}

function formatTs(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', 'Z');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let scrollRaf = 0;
scroller.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    render();
  });
});

window.addEventListener('resize', () => render());

function applyFilterChange() {
  // New generation invalidates all in-flight responses and cache.
  state.generation++;
  state.pages.clear();
  state.pending.clear();
  // Reset scroll to top.
  scroller.scrollTop = 0;
  // Clear DOM row pool.
  for (const [, node] of rowNodes) node.remove();
  rowNodes.clear();
  syncBadgeActive();
  updateCount();
  refreshTotal();
}

severitySel.addEventListener('change', () => {
  state.filter.severity = severitySel.value;
  applyFilterChange();
});

let debounceTimer = 0;
searchInput.addEventListener('input', () => {
  // Never block the input; debounce the query.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const val = searchInput.value.trim();
    if (val === state.filter.q) return;
    state.filter.q = val;
    applyFilterChange();
  }, DEBOUNCE_MS);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  await fetchStats();
  await refreshTotal();
  render();
}

boot();
