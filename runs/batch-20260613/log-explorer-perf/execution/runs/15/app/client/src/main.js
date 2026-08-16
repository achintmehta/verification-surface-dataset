const ROW_HEIGHT = 28; // must match --row-height in style.css
const WINDOW_LIMIT = 200; // server cap; we fetch pages of this size
const OVERSCAN = 10; // extra rows above/below the viewport

const scroller = document.getElementById('scroller');
const sizer = document.getElementById('sizer');
const viewport = document.getElementById('viewport');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

// --- State ------------------------------------------------------------------
const state = {
  total: 0,
  severity: '',
  q: '',
  // filterEpoch increments whenever the filter changes so stale fetches are
  // discarded and stale renders never overwrite newer state.
  filterEpoch: 0,
};

// Row cache: id -> row object, keyed by absolute offset within current filter.
let rowCache = new Map(); // offset -> row
let cacheEpoch = 0; // epoch the cache belongs to

// Track in-flight window fetches to avoid duplicate requests.
const pendingWindows = new Set(); // "startOffset" strings

// Recycled row DOM nodes.
const rowPool = [];
const activeRows = new Map(); // offset -> DOM node

// --- Helpers ----------------------------------------------------------------
function fmtTs(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function buildQuery(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return `/api/logs?${params.toString()}`;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function updateCount() {
  countEl.textContent = `${state.total.toLocaleString()} of ${state.total.toLocaleString()}`;
}

// --- Window fetching --------------------------------------------------------
// Round an offset down to a window boundary so pages align and cache reuse.
function windowStart(offset) {
  return Math.floor(offset / WINDOW_LIMIT) * WINDOW_LIMIT;
}

async function fetchWindow(startOffset, epoch) {
  const key = String(startOffset);
  if (pendingWindows.has(key)) return;
  pendingWindows.add(key);

  const url = buildQuery(startOffset, WINDOW_LIMIT);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Discard if the filter changed while this was in flight.
    if (epoch !== state.filterEpoch) return;

    // total may have been established already; keep it authoritative.
    if (data.total !== state.total) {
      state.total = data.total;
      applySizer();
      updateCount();
    }

    for (let i = 0; i < data.rows.length; i++) {
      rowCache.set(startOffset + i, data.rows[i]);
    }
    render();
  } catch (err) {
    if (epoch === state.filterEpoch) {
      setStatus(`Fetch error: ${err.message}`);
    }
  } finally {
    pendingWindows.delete(key);
  }
}

// --- Virtualization ---------------------------------------------------------
function applySizer() {
  sizer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function acquireRowNode() {
  let node = rowPool.pop();
  if (!node) {
    node = document.createElement('div');
    node.className = 'log-row';
    node.innerHTML =
      '<div class="col col-ts"></div>' +
      '<div class="col col-sev"></div>' +
      '<div class="col col-svc"></div>' +
      '<div class="col col-msg"></div>';
    viewport.appendChild(node);
  }
  node.style.display = 'flex';
  return node;
}

function releaseRowNode(node) {
  node.style.display = 'none';
  rowPool.push(node);
}

function paintRow(node, offset, row) {
  node.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
  const [tsEl, sevEl, svcEl, msgEl] = node.children;
  if (row) {
    node.classList.remove('row-placeholder');
    tsEl.textContent = fmtTs(row.ts);
    sevEl.innerHTML = `<span class="sev-badge sev-${row.severity}">${row.severity}</span>`;
    svcEl.textContent = row.service;
    msgEl.textContent = row.message;
  } else {
    node.classList.add('row-placeholder');
    tsEl.textContent = '';
    sevEl.textContent = '';
    svcEl.textContent = '';
    msgEl.textContent = '…';
  }
}

function render() {
  const scrollTop = scroller.scrollTop;
  const viewHeight = scroller.clientHeight;

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(state.total, first + visibleCount);

  const needed = new Set();
  for (let offset = first; offset < last; offset++) needed.add(offset);

  // Recycle rows no longer needed.
  for (const [offset, node] of activeRows) {
    if (!needed.has(offset)) {
      releaseRowNode(node);
      activeRows.delete(offset);
    }
  }

  // Paint needed rows.
  const missingWindows = new Set();
  for (let offset = first; offset < last; offset++) {
    let node = activeRows.get(offset);
    const row = rowCache.get(offset);
    if (!node) {
      node = acquireRowNode();
      activeRows.set(offset, node);
    }
    paintRow(node, offset, row);
    if (row === undefined) {
      missingWindows.add(windowStart(offset));
    }
  }

  // Kick off fetches for any windows that are missing.
  for (const startOffset of missingWindows) {
    fetchWindow(startOffset, state.filterEpoch);
  }
}

// --- Filters ----------------------------------------------------------------
function resetForNewFilter() {
  state.filterEpoch++;
  cacheEpoch = state.filterEpoch;
  rowCache = new Map();
  pendingWindows.clear();
  // Recycle all active rows.
  for (const [, node] of activeRows) releaseRowNode(node);
  activeRows.clear();
  scroller.scrollTop = 0;
}

async function applyFilters() {
  resetForNewFilter();
  const epoch = state.filterEpoch;
  setStatus('Loading…');
  try {
    const res = await fetch(buildQuery(0, WINDOW_LIMIT));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (epoch !== state.filterEpoch) return; // stale

    state.total = data.total;
    for (let i = 0; i < data.rows.length; i++) rowCache.set(i, data.rows[i]);

    applySizer();
    updateCount();
    render();
    setStatus('');
  } catch (err) {
    if (epoch === state.filterEpoch) setStatus(`Error: ${err.message}`);
  }
}

// --- Event wiring -----------------------------------------------------------
let scrollScheduled = false;
scroller.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    render();
  });
});

window.addEventListener('resize', () => render());

severityEl.addEventListener('change', () => {
  state.severity = severityEl.value;
  applyFilters();
});

let debounceTimer = null;
searchEl.addEventListener('input', () => {
  // Never block input on queries; just schedule a debounced fetch.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    applyFilters();
  }, 200);
});

// --- Boot -------------------------------------------------------------------
async function boot() {
  setStatus('Loading corpus…');
  await applyFilters();
}

boot();
