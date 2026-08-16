const ROW_H = 28;          // must match --row-h in CSS
const PAGE = 200;          // server max window (rows fetched per page)
const OVERSCAN = 10;       // extra rows above/below viewport
const CACHE_PAGES = 8;     // LRU cache of fetched pages

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const counterEl = document.getElementById('counter');
const badgesEl = document.getElementById('badges');

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const state = {
  total: 0,
  corpusTotal: 0,
  severity: '',
  q: '',
  // filter generation — bumped on every filter change so stale responses drop.
  gen: 0,
  // page cache: pageIndex -> { rows, gen }
  pages: new Map(),
  pageOrder: [],          // LRU order of page indices
  inflight: new Map(),    // pageIndex -> AbortController
};

// row element pool (recycled)
const pool = [];

function makeRow() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML =
    '<span class="col-ts"></span>' +
    '<span class="col-sev"></span>' +
    '<span class="col-svc"></span>' +
    '<span class="col-msg"></span>';
  return {
    el: row,
    ts: row.children[0],
    sev: row.children[1],
    svc: row.children[2],
    msg: row.children[3],
  };
}

// -----------------------------------------------------------------------------
// Fetching windows
// -----------------------------------------------------------------------------
function filterKey() {
  return `${state.severity}|${state.q}`;
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    state.corpusTotal = data.total;
    renderBadges(data.bySeverity);
    updateCounter();
  } catch (e) {
    // non-fatal
  }
}

const SEV_ORDER = ['debug', 'info', 'warn', 'error'];
function renderBadges(bySeverity) {
  badgesEl.innerHTML = '';
  for (const s of SEV_ORDER) {
    const b = document.createElement('span');
    b.className = 'badge ' + s;
    b.innerHTML = `<span class="dot"></span>${s}: ${(bySeverity[s] || 0).toLocaleString()}`;
    badgesEl.appendChild(b);
  }
}

// Fetch the total count + first page for the current filter (resets everything).
async function loadFilter() {
  const gen = ++state.gen;
  // abort in-flight
  for (const c of state.inflight.values()) c.abort();
  state.inflight.clear();
  state.pages.clear();
  state.pageOrder = [];

  const params = buildParams(0, PAGE);
  try {
    const res = await fetch('/api/logs?' + params.toString());
    if (!res.ok) return;
    const data = await res.json();
    if (gen !== state.gen) return; // stale
    state.total = data.total;
    cachePage(0, data.rows, gen);
    // Reset scroll and size the scroller.
    viewport.scrollTop = 0;
    resize();
    render();
    updateCounter();
  } catch (e) {
    /* aborted / network */
  }
}

function buildParams(offset, limit) {
  const p = new URLSearchParams();
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  if (state.severity) p.set('severity', state.severity);
  if (state.q) p.set('q', state.q);
  return p;
}

function cachePage(pageIndex, rows, gen) {
  state.pages.set(pageIndex, { rows, gen });
  // LRU bookkeeping
  const existing = state.pageOrder.indexOf(pageIndex);
  if (existing !== -1) state.pageOrder.splice(existing, 1);
  state.pageOrder.push(pageIndex);
  while (state.pageOrder.length > CACHE_PAGES) {
    const evict = state.pageOrder.shift();
    state.pages.delete(evict);
  }
}

function ensurePage(pageIndex) {
  if (pageIndex < 0) return;
  if (state.pages.has(pageIndex)) {
    // touch LRU
    const i = state.pageOrder.indexOf(pageIndex);
    if (i !== -1) {
      state.pageOrder.splice(i, 1);
      state.pageOrder.push(pageIndex);
    }
    return;
  }
  if (state.inflight.has(pageIndex)) return;

  const gen = state.gen;
  const controller = new AbortController();
  state.inflight.set(pageIndex, controller);
  const params = buildParams(pageIndex * PAGE, PAGE);

  fetch('/api/logs?' + params.toString(), { signal: controller.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      state.inflight.delete(pageIndex);
      if (!data) return;
      if (gen !== state.gen) return; // stale filter
      cachePage(pageIndex, data.rows, gen);
      render(); // re-render now that data arrived
    })
    .catch(() => {
      state.inflight.delete(pageIndex);
    });
}

function getRow(index) {
  const pageIndex = Math.floor(index / PAGE);
  const page = state.pages.get(pageIndex);
  if (!page || page.gen !== state.gen) return null;
  return page.rows[index - pageIndex * PAGE] || null;
}

// -----------------------------------------------------------------------------
// Virtual rendering
// -----------------------------------------------------------------------------
function resize() {
  spacer.style.height = state.total * ROW_H + 'px';
}

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

function render() {
  const scrollTop = viewport.scrollTop;
  const height = viewport.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(height / ROW_H) + OVERSCAN * 2;
  const last = Math.min(state.total, first + visibleCount);

  // Ensure pages covering the visible range are loaded.
  if (state.total > 0) {
    const firstPage = Math.floor(first / PAGE);
    const lastPage = Math.floor((last - 1) / PAGE);
    for (let pg = firstPage; pg <= lastPage; pg++) ensurePage(pg);
  }

  const needed = Math.max(0, last - first);

  // Grow pool as needed.
  while (pool.length < needed) {
    const r = makeRow();
    pool.push(r);
    rowsEl.appendChild(r.el);
  }
  // Hide extra pooled rows.
  for (let i = needed; i < pool.length; i++) {
    if (pool[i].el.style.display !== 'none') pool[i].el.style.display = 'none';
  }

  for (let i = 0; i < needed; i++) {
    const index = first + i;
    const cell = pool[i];
    cell.el.style.display = '';
    cell.el.style.transform = `translateY(${index * ROW_H}px)`;
    cell.el.style.position = 'absolute';
    cell.el.style.left = '0';
    cell.el.style.right = '0';

    const row = getRow(index);
    if (row) {
      cell.el.className = 'log-row sev-' + row.severity;
      cell.ts.textContent = formatTs(row.ts);
      cell.sev.textContent = row.severity;
      cell.svc.textContent = row.service;
      cell.msg.textContent = row.message;
    } else {
      cell.el.className = 'log-row loading';
      cell.ts.textContent = '';
      cell.sev.textContent = '';
      cell.svc.textContent = '';
      cell.msg.textContent = '…';
    }
  }
}

function formatTs(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    '-' + pad(d.getUTCMonth() + 1) +
    '-' + pad(d.getUTCDate()) +
    ' ' + pad(d.getUTCHours()) +
    ':' + pad(d.getUTCMinutes()) +
    ':' + pad(d.getUTCSeconds())
  );
}

function updateCounter() {
  const corpus = state.corpusTotal || state.total;
  counterEl.textContent =
    state.total.toLocaleString() + ' of ' + corpus.toLocaleString();
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------
viewport.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender);

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  loadFilter();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  const value = searchInput.value.trim();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (value === state.q) return;
    state.q = value;
    loadFilter();
  }, 250);
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
fetchStats();
loadFilter();
