import './style.css';

const ROW_HEIGHT = 28; // must match --row-h in style.css
const PAGE_LIMIT = 200; // fetch window size (backend cap); overscan lives inside this
const OVERSCAN = 10; // extra rows above/below the viewport
const DEBOUNCE_MS = 200;

// --- DOM references ---------------------------------------------------------
const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');
const badgesEl = document.getElementById('badges');

// --- State ------------------------------------------------------------------
const state = {
  total: 0,
  severity: '',
  q: '',
  // cache of fetched windows: Map<windowStartOffset, {rows, promise?}>
  cache: new Map(),
  requestSeq: 0, // monotonically increasing token; stale responses are dropped
  loadSeq: 0, // per-window fetch token
  pendingWindows: new Set(),
};

// --- Utilities --------------------------------------------------------------
function formatTs(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function windowStartFor(offset) {
  return Math.floor(offset / PAGE_LIMIT) * PAGE_LIMIT;
}

function buildUrl(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return `/api/logs?${params.toString()}`;
}

// --- Data loading -----------------------------------------------------------

// Fetch the window that contains `windowStart`. Uses the request generation
// token so responses from a superseded filter are discarded.
async function ensureWindow(windowStart, generation) {
  if (state.cache.has(windowStart) || state.pendingWindows.has(windowStart)) return;
  state.pendingWindows.add(windowStart);
  try {
    const res = await fetch(buildUrl(windowStart, PAGE_LIMIT));
    if (generation !== state.requestSeq) return; // stale filter
    if (!res.ok) return;
    const data = await res.json();
    if (generation !== state.requestSeq) return; // stale filter (double-check post-await)
    state.total = data.total;
    state.cache.set(windowStart, data.rows);
    render();
  } catch (_e) {
    // Network error: leave the window uncached so a later scroll retries it.
  } finally {
    state.pendingWindows.delete(windowStart);
  }
}

function getRow(offset) {
  const ws = windowStartFor(offset);
  const win = state.cache.get(ws);
  if (!win) return undefined;
  return win[offset - ws];
}

// --- Rendering --------------------------------------------------------------

function render() {
  // Total scroll height reflects the filtered total.
  const totalHeight = state.total * ROW_HEIGHT;
  spacer.style.height = `${totalHeight}px`;

  updateCount();

  const scrollTop = viewport.scrollTop;
  const viewH = viewport.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewH / ROW_HEIGHT);

  let start = Math.max(0, firstVisible - OVERSCAN);
  let end = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);

  // Ensure windows covering the visible range are loaded.
  const gen = state.requestSeq;
  const firstWindow = windowStartFor(start);
  const lastWindow = windowStartFor(Math.max(start, end - 1));
  for (let ws = firstWindow; ws <= lastWindow; ws += PAGE_LIMIT) {
    ensureWindow(ws, gen);
  }

  // Position the rows container at the first rendered row's offset.
  rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

  // Build (or recycle) row nodes.
  const needed = Math.max(0, end - start);
  reconcileRowNodes(needed);

  const children = rowsEl.children;
  for (let i = 0; i < needed; i++) {
    const offset = start + i;
    const node = children[i];
    const row = getRow(offset);
    fillRow(node, row, offset);
  }

  if (state.total === 0) {
    showEmpty();
  } else {
    hideEmpty();
  }
}

let emptyEl = null;
function showEmpty() {
  if (!emptyEl) {
    emptyEl = document.createElement('div');
    emptyEl.className = 'empty';
    emptyEl.textContent = 'No matching log entries.';
    viewport.appendChild(emptyEl);
  }
}
function hideEmpty() {
  if (emptyEl) {
    emptyEl.remove();
    emptyEl = null;
  }
}

// Row-window pool: create/remove DOM nodes so only ~visible rows exist.
function reconcileRowNodes(needed) {
  const children = rowsEl.children;
  while (children.length < needed) {
    rowsEl.appendChild(createRowNode());
  }
  while (children.length > needed) {
    rowsEl.removeChild(rowsEl.lastChild);
  }
}

function createRowNode() {
  const row = document.createElement('div');
  row.className = 'log-row';
  const ts = document.createElement('div');
  ts.className = 'cell col-ts';
  const sev = document.createElement('div');
  sev.className = 'cell col-sev';
  const svc = document.createElement('div');
  svc.className = 'cell col-svc';
  const msg = document.createElement('div');
  msg.className = 'cell col-msg';
  row.append(ts, sev, svc, msg);
  return row;
}

function fillRow(node, row, offset) {
  const [tsEl, sevEl, svcEl, msgEl] = node.children;
  if (!row) {
    tsEl.textContent = '';
    sevEl.textContent = '';
    sevEl.className = 'cell col-sev';
    svcEl.textContent = '';
    msgEl.textContent = '…';
    node.dataset.offset = String(offset);
    return;
  }
  tsEl.textContent = formatTs(row.ts);
  sevEl.textContent = row.severity;
  sevEl.className = `cell col-sev sev-${row.severity}`;
  svcEl.textContent = row.service;
  msgEl.textContent = row.message;
  node.dataset.offset = String(offset);
}

function updateCount() {
  countEl.textContent = `${state.total.toLocaleString()} of ${(window.__grandTotal ?? state.total).toLocaleString()}`;
}

// --- Filters ----------------------------------------------------------------

function resetForNewFilter() {
  state.requestSeq += 1;
  state.cache.clear();
  state.pendingWindows.clear();
  state.total = 0;
  viewport.scrollTop = 0;
  render();
  // Kick off loading the first window.
  ensureWindow(0, state.requestSeq);
}

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    resetForNewFilter();
  }, DEBOUNCE_MS);
});

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  syncBadges();
  resetForNewFilter();
});

// --- Scroll -----------------------------------------------------------------

let scrollScheduled = false;
viewport.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    render();
  });
});

window.addEventListener('resize', () => render());

// --- Stats / badges ---------------------------------------------------------

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const stats = await res.json();
    window.__grandTotal = stats.total;
    window.__bySeverity = stats.bySeverity;
    renderBadges(stats);
    updateCount();
  } catch (_e) {
    /* ignore */
  }
}

function renderBadges(stats) {
  badgesEl.innerHTML = '';
  const entries = [
    ['', 'all', stats.total],
    ...['debug', 'info', 'warn', 'error'].map((s) => [s, s, stats.bySeverity[s] ?? 0]),
  ];
  for (const [value, label, c] of entries) {
    const badge = document.createElement('div');
    badge.className = 'badge' + (state.severity === value ? ' active' : '');
    if (value) {
      const dot = document.createElement('span');
      dot.className = `dot ${value}`;
      badge.appendChild(dot);
    }
    const text = document.createElement('span');
    text.textContent = `${label} ${c.toLocaleString()}`;
    badge.appendChild(text);
    badge.addEventListener('click', () => {
      state.severity = value;
      severitySel.value = value;
      syncBadges();
      resetForNewFilter();
    });
    badgesEl.appendChild(badge);
  }
}

function syncBadges() {
  const badges = badgesEl.querySelectorAll('.badge');
  const values = ['', 'debug', 'info', 'warn', 'error'];
  badges.forEach((b, i) => {
    b.classList.toggle('active', values[i] === state.severity);
  });
}

// --- Boot -------------------------------------------------------------------

async function init() {
  await loadStats();
  resetForNewFilter();
}

init();
