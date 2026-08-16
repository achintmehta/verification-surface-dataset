import { fetchLogs, fetchStats } from './api.js';

const ROW_H = 28;          // must match --row-h in CSS
const WINDOW = 200;        // rows fetched per request (server cap)
const OVERSCAN = 20;       // extra rows above/below viewport
const PAGE_CACHE_MAX = 8;  // recently fetched windows kept in memory

// ---- DOM refs ----
const scroller = document.getElementById('scroller');
const sizer = document.getElementById('sizer');
const viewport = document.getElementById('viewport');
const emptyEl = document.getElementById('empty');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const rowCountEl = document.getElementById('rowcount');

// ---- state ----
const state = {
  total: 0,
  severity: '',
  q: '',
  // page cache: windowStart(offset) -> { rows, ts }
  pages: new Map(),
  // token that increments on every filter change; used to drop stale responses
  filterToken: 0,
  // set of window offsets currently being fetched (per filterToken)
  inflight: new Map(),
};

// pool of reusable row elements keyed by DOM node
const rowPool = [];
let activeRows = new Map(); // rowIndex -> element

function makeRowEl() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-sev"><span class="sev-badge"></span></div>' +
    '<div class="col col-svc"></div>' +
    '<div class="col col-msg"></div>';
  el.refs = {
    ts: el.children[0],
    sevWrap: el.children[1],
    sev: el.children[1].firstChild,
    svc: el.children[2],
    msg: el.children[3],
  };
  return el;
}

function acquireRowEl() {
  return rowPool.pop() || makeRowEl();
}

function releaseRowEl(el) {
  el.style.display = 'none';
  rowPool.push(el);
}

function fmtTs(iso) {
  // Render as compact UTC. iso like 2024-01-15T09:33:12.000Z
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function windowStartFor(rowIndex) {
  return Math.floor(rowIndex / WINDOW) * WINDOW;
}

// ---- data fetching ----
async function ensureWindow(windowStart, token) {
  if (state.pages.has(windowStart)) {
    // refresh recency
    const p = state.pages.get(windowStart);
    p.ts = Date.now();
    return;
  }
  const key = windowStart;
  if (state.inflight.has(key)) return;

  const controller = new AbortController();
  state.inflight.set(key, controller);

  try {
    const data = await fetchLogs({
      offset: windowStart,
      limit: WINDOW,
      severity: state.severity,
      q: state.q,
      signal: controller.signal,
    });
    // stale check: filters changed while in flight
    if (token !== state.filterToken) return;

    state.total = data.total;
    state.pages.set(windowStart, { rows: data.rows, ts: Date.now() });
    evictPages();
    updateSizer();
    render();
    updateCounts();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('fetch window failed', err);
  } finally {
    state.inflight.delete(key);
  }
}

function evictPages() {
  if (state.pages.size <= PAGE_CACHE_MAX) return;
  const entries = [...state.pages.entries()].sort((a, b) => a[1].ts - b[1].ts);
  while (entries.length > PAGE_CACHE_MAX) {
    const [k] = entries.shift();
    state.pages.delete(k);
  }
}

function rowAt(rowIndex) {
  const ws = windowStartFor(rowIndex);
  const page = state.pages.get(ws);
  if (!page) return undefined;
  return page.rows[rowIndex - ws];
}

// ---- rendering (virtualization) ----
function render() {
  const scrollTop = scroller.scrollTop;
  const viewH = scroller.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_H);
  const visibleCount = Math.ceil(viewH / ROW_H);

  let start = Math.max(0, firstVisible - OVERSCAN);
  let end = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);

  // Ensure the windows covering [start,end) are loaded.
  const needed = new Set();
  for (let ws = windowStartFor(start); ws < end; ws += WINDOW) {
    needed.add(ws);
  }
  for (const ws of needed) {
    if (!state.pages.has(ws)) ensureWindow(ws, state.filterToken);
  }

  // Recycle: release rows no longer in range.
  for (const [idx, el] of activeRows) {
    if (idx < start || idx >= end) {
      activeRows.delete(idx);
      releaseRowEl(el);
    }
  }

  // Place / update rows in range.
  for (let idx = start; idx < end; idx++) {
    const data = rowAt(idx);
    let el = activeRows.get(idx);

    if (!data) {
      // no data yet — leave a placeholder-free gap; keep element if present but blank
      if (el) {
        activeRows.delete(idx);
        releaseRowEl(el);
      }
      continue;
    }

    if (!el) {
      el = acquireRowEl();
      el.style.display = '';
      viewport.appendChild(el);
      activeRows.set(idx, el);
    }
    el.style.transform = `translateY(${idx * ROW_H}px)`;
    el.classList.toggle('zebra', idx % 2 === 1);
    el.refs.ts.textContent = fmtTs(data.ts);
    el.refs.sev.textContent = data.severity;
    el.refs.sev.className = 'sev-badge sev-' + data.severity;
    el.refs.svc.textContent = data.service;
    el.refs.msg.textContent = data.message;
  }
}

function updateSizer() {
  sizer.style.height = state.total * ROW_H + 'px';
}

function updateCounts() {
  rowCountEl.textContent = `${state.total.toLocaleString()} of ${window.__grandTotal?.toLocaleString() ?? state.total.toLocaleString()}`;
  emptyEl.hidden = state.total !== 0;
}

// ---- filter changes ----
function resetForNewFilter() {
  state.filterToken++;
  // cancel inflight
  for (const c of state.inflight.values()) c.abort();
  state.inflight.clear();
  state.pages.clear();
  // clear rendered rows
  for (const [, el] of activeRows) releaseRowEl(el);
  activeRows.clear();
  scroller.scrollTop = 0;
  // fetch first window to get total quickly
  ensureWindow(0, state.filterToken).then(() => {
    updateSizer();
    updateCounts();
  });
}

// ---- event wiring ----
let scrollScheduled = false;
scroller.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    render();
  });
});

window.addEventListener('resize', render);

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  resetForNewFilter();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    resetForNewFilter();
  }, 220);
});

// ---- boot ----
async function boot() {
  try {
    const stats = await fetchStats();
    window.__grandTotal = stats.total;
  } catch (e) {
    console.error('stats failed', e);
  }
  const data = await fetchLogs({ offset: 0, limit: WINDOW, severity: '', q: '' });
  state.total = data.total;
  state.pages.set(0, { rows: data.rows, ts: Date.now() });
  updateSizer();
  updateCounts();
  render();
}

boot();
