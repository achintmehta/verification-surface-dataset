// Virtualized log explorer.
//
// Core idea: the scroll container holds a spacer sized to `total * ROW_HEIGHT`
// so the native scrollbar reflects the whole (filtered) corpus. The DOM only
// ever contains the rows intersecting the viewport (plus overscan). Rows are
// fetched window-by-window from the API and cached; a pool of row elements is
// recycled as the user scrolls.

const ROW_HEIGHT = 28;
const OVERSCAN = 8; // rows above/below the viewport
const PAGE_SIZE = 200; // fetch window size (== API cap)
const DEBOUNCE_MS = 200;

const API = {
  logs: '/api/logs',
  stats: '/api/stats',
};

// --- DOM refs ---------------------------------------------------------------
const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

// --- State ------------------------------------------------------------------
const state = {
  total: 0, // filtered total
  grandTotal: 0, // unfiltered total (for "N of M")
  severity: 'all',
  q: '',
  // Cache of fetched rows keyed by absolute offset. Map<offset, rowObj|null>
  // null == a load is in flight for that offset.
  cache: new Map(),
  // Track which page starts have been requested to avoid duplicate fetches.
  pendingPages: new Set(),
  // Monotonic token: each filter change bumps this; stale responses are dropped.
  filterEpoch: 0,
};

// --- Row element pool -------------------------------------------------------
// We keep a pool of reusable .log-row elements. Each is positioned absolutely
// by translateY. This bounds DOM size to ~(visible + overscan) elements.
const pool = [];

function acquireRow(i) {
  let el = pool[i];
  if (!el) {
    el = document.createElement('div');
    el.className = 'log-row';
    const ts = document.createElement('span');
    ts.className = 'col col-ts';
    const sev = document.createElement('span');
    sev.className = 'col col-sev';
    const badge = document.createElement('span');
    badge.className = 'sev-badge';
    sev.appendChild(badge);
    const svc = document.createElement('span');
    svc.className = 'col col-svc';
    const msg = document.createElement('span');
    msg.className = 'col col-msg';
    el.append(ts, sev, svc, msg);
    el._refs = { ts, sev, badge, svc, msg };
    rowsEl.appendChild(el);
    pool[i] = el;
  }
  return el;
}

function fmtTs(iso) {
  // Compact, deterministic display.
  const d = new Date(iso);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

function paintRow(el, offset, row) {
  const { ts, badge, svc, msg } = el._refs;
  el.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
  if (row) {
    el.classList.remove('loading');
    ts.textContent = fmtTs(row.ts);
    badge.textContent = row.severity;
    badge.className = `sev-badge sev-${row.severity}`;
    svc.textContent = row.service;
    msg.textContent = row.message;
    msg.title = row.message;
  } else {
    el.classList.add('loading');
    ts.textContent = '…';
    badge.textContent = '';
    badge.className = 'sev-badge';
    svc.textContent = '';
    msg.textContent = 'loading…';
    msg.title = '';
  }
  el.style.display = '';
}

// --- Fetching ---------------------------------------------------------------

function pageStartFor(offset) {
  return Math.floor(offset / PAGE_SIZE) * PAGE_SIZE;
}

async function fetchPage(pageStart, epoch) {
  if (state.pendingPages.has(pageStart)) return;
  state.pendingPages.add(pageStart);

  const params = new URLSearchParams();
  params.set('offset', String(pageStart));
  params.set('limit', String(PAGE_SIZE));
  if (state.severity !== 'all') params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const res = await fetch(`${API.logs}?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Stale-response guard: drop if a newer filter epoch is active.
    if (epoch !== state.filterEpoch) return;

    // total may drift if data changed; keep it in sync (it won't here, but
    // it's the authoritative number for scrollbar sizing under filters).
    if (data.total !== state.total) {
      state.total = data.total;
      sizeSpacer();
      updateCount();
    }

    data.rows.forEach((row, i) => {
      state.cache.set(pageStart + i, row);
    });
    render();
  } catch (err) {
    if (epoch === state.filterEpoch) {
      setStatus('error loading window');
    }
  } finally {
    state.pendingPages.delete(pageStart);
  }
}

function ensureWindowLoaded(startOffset, endOffset) {
  const epoch = state.filterEpoch;
  const firstPage = pageStartFor(startOffset);
  const lastPage = pageStartFor(Math.max(startOffset, endOffset - 1));
  for (let p = firstPage; p <= lastPage; p += PAGE_SIZE) {
    if (p >= state.total) continue;
    // If any offset in the page is missing, (re)fetch the page.
    let needsFetch = false;
    for (let o = p; o < p + PAGE_SIZE && o < state.total; o++) {
      if (!state.cache.has(o)) {
        needsFetch = true;
        break;
      }
    }
    if (needsFetch) fetchPage(p, epoch);
  }
}

// --- Rendering --------------------------------------------------------------

function sizeSpacer() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateCount() {
  countEl.textContent = `${state.total.toLocaleString()} of ${state.grandTotal.toLocaleString()}`;
}

function setStatus(text) {
  statusEl.textContent = text || '';
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);

  let start = Math.max(0, firstVisible - OVERSCAN);
  let end = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);

  ensureWindowLoaded(start, end);

  const needed = Math.max(0, end - start);

  // Paint each needed row from the pool.
  for (let i = 0; i < needed; i++) {
    const offset = start + i;
    const el = acquireRow(i);
    const row = state.cache.get(offset); // may be undefined -> loading
    paintRow(el, offset, row || null);
  }
  // Hide any surplus pooled rows beyond what's needed.
  for (let i = needed; i < pool.length; i++) {
    if (pool[i]) pool[i].style.display = 'none';
  }
}

// --- Filter changes ---------------------------------------------------------

async function applyFilters({ resetScroll } = { resetScroll: true }) {
  // Bump epoch so any in-flight page responses are ignored.
  state.filterEpoch += 1;
  state.cache.clear();
  state.pendingPages.clear();

  if (resetScroll) {
    viewport.scrollTop = 0;
  }

  setStatus('loading…');
  const epoch = state.filterEpoch;

  // Fetch the first page to learn the filtered total quickly.
  const params = new URLSearchParams();
  params.set('offset', '0');
  params.set('limit', String(PAGE_SIZE));
  if (state.severity !== 'all') params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const res = await fetch(`${API.logs}?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (epoch !== state.filterEpoch) return; // superseded

    state.total = data.total;
    data.rows.forEach((row, i) => state.cache.set(i, row));
    sizeSpacer();
    updateCount();
    setStatus('');
    render();
  } catch (err) {
    if (epoch === state.filterEpoch) setStatus('error');
  }
}

// --- Events -----------------------------------------------------------------

viewport.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender);

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  applyFilters();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  // Never block the input: debounce and fire async.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const v = searchInput.value.trim();
    if (v === state.q) return;
    state.q = v;
    applyFilters();
  }, DEBOUNCE_MS);
});

// --- Boot -------------------------------------------------------------------

async function boot() {
  try {
    const res = await fetch(API.stats);
    const stats = await res.json();
    state.grandTotal = stats.total;
  } catch {
    state.grandTotal = 0;
  }
  await applyFilters({ resetScroll: true });
}

boot();
