import { fetchLogs, fetchStats } from './api.js';

const ROW_HEIGHT = 28;
const WINDOW_LIMIT = 200; // max rows per API call
const OVERSCAN = 10; // extra rows above/below the viewport
const DEBOUNCE_MS = 200;
// PGLite (and browsers) limit element height; 100k * 28px = 2.8M px which is
// well within browser limits, so a direct 1:1 mapping is fine here.

const els = {
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
};

const state = {
  severity: '',
  q: '',
  total: 0,
  // rowCache maps absolute row index -> row object.
  cache: new Map(),
  // Monotonic token: only responses matching the latest filter token are applied.
  filterToken: 0,
  // Per-window request tokens to drop out-of-order window responses.
  windowToken: 0,
  // Set of window start offsets currently being fetched.
  inflight: new Map(),
  // Recycled row DOM nodes keyed by pool index.
  pool: [],
  poolSize: 0,
};

// ---- rendering ---------------------------------------------------------

function severityClass(sev) {
  return `sev-${sev}`;
}

function fmtTs(ts) {
  // ISO -> "YYYY-MM-DD HH:MM:SS"
  return ts.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
}

function ensurePool(size) {
  while (state.pool.length < size) {
    const row = document.createElement('div');
    row.className = 'row';
    const ts = document.createElement('div'); ts.className = 'col col-ts';
    const sev = document.createElement('div'); sev.className = 'col col-sev';
    const svc = document.createElement('div'); svc.className = 'col col-svc';
    const msg = document.createElement('div'); msg.className = 'col col-msg';
    row.append(ts, sev, svc, msg);
    row._cells = { ts, sev, svc, msg };
    row.style.position = 'absolute';
    row.style.left = '0';
    row.style.right = '0';
    els.rows.appendChild(row);
    state.pool.push(row);
  }
}

function paintRow(node, index) {
  const data = state.cache.get(index);
  node.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  node.style.display = 'flex';
  if (!data) {
    node.classList.add('loading');
    node._cells.ts.textContent = '';
    node._cells.sev.textContent = '';
    node._cells.svc.textContent = '';
    node._cells.msg.textContent = '…';
    node._cells.sev.className = 'col col-sev';
    return;
  }
  node.classList.remove('loading');
  node._cells.ts.textContent = fmtTs(data.ts);
  node._cells.sev.textContent = data.severity;
  node._cells.sev.className = `col col-sev ${severityClass(data.severity)}`;
  node._cells.svc.textContent = data.service;
  node._cells.msg.textContent = data.message;
}

function render() {
  const scrollTop = els.viewport.scrollTop;
  const viewportHeight = els.viewport.clientHeight;

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(state.total, first + visibleCount);
  const needed = Math.max(0, last - first);

  ensurePool(needed);

  // Hide unused pool nodes.
  for (let i = needed; i < state.pool.length; i++) {
    state.pool[i].style.display = 'none';
  }

  for (let i = 0; i < needed; i++) {
    paintRow(state.pool[i], first + i);
  }

  requestWindows(first, last);
}

// ---- data fetching -----------------------------------------------------

function requestWindows(first, last) {
  if (state.total === 0) return;
  // Align to WINDOW_LIMIT boundaries and fetch any window that overlaps the
  // needed range and isn't cached/in-flight.
  const startWindow = Math.floor(first / WINDOW_LIMIT) * WINDOW_LIMIT;
  for (let ws = startWindow; ws < last; ws += WINDOW_LIMIT) {
    if (isWindowSatisfied(ws)) continue;
    if (state.inflight.has(ws)) continue;
    fetchWindow(ws);
  }
}

function isWindowSatisfied(windowStart) {
  const end = Math.min(state.total, windowStart + WINDOW_LIMIT);
  for (let i = windowStart; i < end; i++) {
    if (!state.cache.has(i)) return false;
  }
  return true;
}

function fetchWindow(windowStart) {
  const controller = new AbortController();
  const filterToken = state.filterToken;
  state.inflight.set(windowStart, controller);

  fetchLogs(
    {
      offset: windowStart,
      limit: WINDOW_LIMIT,
      severity: state.severity,
      q: state.q,
    },
    controller.signal
  )
    .then((data) => {
      // Drop responses from a stale filter generation.
      if (filterToken !== state.filterToken) return;
      // total may have shifted between the count and the window under
      // concurrent conditions; trust the freshest total we get.
      if (typeof data.total === 'number') state.total = data.total;
      data.rows.forEach((row, i) => {
        state.cache.set(windowStart + i, row);
      });
      state.inflight.delete(windowStart);
      updateCount();
      render();
    })
    .catch((err) => {
      state.inflight.delete(windowStart);
      if (err.name === 'AbortError') return;
      console.error('window fetch failed', err);
    });
}

// ---- filter changes ----------------------------------------------------

function updateSpacer() {
  els.spacer.style.height = `${Math.max(state.total, 0) * ROW_HEIGHT}px`;
}

function updateCount() {
  els.count.textContent = `${state.total.toLocaleString()} of ${(window._grandTotal ?? state.total).toLocaleString()}`;
}

async function applyFilters({ resetScroll }) {
  // Bump the filter generation; abort every in-flight window.
  state.filterToken++;
  for (const [, controller] of state.inflight) controller.abort();
  state.inflight.clear();
  state.cache.clear();

  if (resetScroll) els.viewport.scrollTop = 0;

  // Fetch the first window synchronously-ish to establish the total quickly.
  const filterToken = state.filterToken;
  const controller = new AbortController();
  state.inflight.set(0, controller);
  try {
    const data = await fetchLogs(
      { offset: 0, limit: WINDOW_LIMIT, severity: state.severity, q: state.q },
      controller.signal
    );
    if (filterToken !== state.filterToken) return; // superseded
    state.total = data.total;
    data.rows.forEach((row, i) => state.cache.set(i, row));
    state.inflight.delete(0);
    updateSpacer();
    updateCount();
    render();
  } catch (err) {
    state.inflight.delete(0);
    if (err.name !== 'AbortError') console.error(err);
  }
}

// ---- events ------------------------------------------------------------

let scrollScheduled = false;
els.viewport.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    render();
  });
});

window.addEventListener('resize', () => render());

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  applyFilters({ resetScroll: true });
});

let debounceTimer = null;
els.search.addEventListener('input', () => {
  // Never block the input; debounce the query.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = els.search.value.trim();
    applyFilters({ resetScroll: true });
  }, DEBOUNCE_MS);
});

// ---- boot --------------------------------------------------------------

async function boot() {
  try {
    const stats = await fetchStats();
    window._grandTotal = stats.total;
  } catch (err) {
    console.error('stats failed', err);
  }
  await applyFilters({ resetScroll: true });
}

boot();
