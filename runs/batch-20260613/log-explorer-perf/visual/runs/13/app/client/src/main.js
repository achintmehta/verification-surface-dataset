import './style.css';

const ROW_H = 32; // must match --row-h in CSS
const WINDOW = 200; // rows fetched per request (== server max limit)
const OVERSCAN = 10; // extra rows above/below viewport

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');
const badgesEl = document.getElementById('badges');
const statusEl = document.getElementById('status');

let grandTotal = 0;

const SEV_ORDER = ['debug', 'info', 'warn', 'error'];

// ---- Application state -------------------------------------------------
const state = {
  severity: '',
  q: '',
  total: 0,
};

// Cache of fetched windows keyed by window index. Values are arrays of rows.
let windows = new Map();
// Track in-flight window fetches so we don't duplicate them.
let inflight = new Map();
// Monotonic token so filter changes invalidate older responses.
let queryToken = 0;
// Pool of DOM row elements, recycled across renders.
const rowPool = [];

// ---- Status indicator --------------------------------------------------
let statusTimer = null;
function setStatus(msg) {
  statusEl.textContent = msg;
  statusEl.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('visible'), 700);
}

// ---- Fetching ----------------------------------------------------------
function buildUrl(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return '/api/logs?' + params.toString();
}

// Fetch a window by index. Guarded against duplicates and stale tokens.
function fetchWindow(windowIndex, token) {
  if (windows.has(windowIndex) || inflight.has(windowIndex)) return;
  const offset = windowIndex * WINDOW;
  if (offset >= state.total && state.total > 0) return;

  const controller = new AbortController();
  const promise = fetch(buildUrl(offset, WINDOW), { signal: controller.signal })
    .then((r) => r.json())
    .then((data) => {
      // Discard if a newer filter query superseded this one.
      if (token !== queryToken) return;
      windows.set(windowIndex, data.rows);
      inflight.delete(windowIndex);
      setStatus(`loaded rows ${offset.toLocaleString()}–${(offset + data.rows.length).toLocaleString()}`);
      render();
    })
    .catch((err) => {
      inflight.delete(windowIndex);
      if (err.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.error('window fetch failed', err);
      }
    });
  inflight.set(windowIndex, { controller, promise });
}

// Cancel every in-flight window fetch (used on filter change).
function cancelInflight() {
  for (const { controller } of inflight.values()) controller.abort();
  inflight.clear();
}

// ---- Total + stats -----------------------------------------------------
// Fetch just the total for the current filter (offset 0, limit 1).
async function refreshTotal(token) {
  const res = await fetch(buildUrl(0, 1));
  const data = await res.json();
  if (token !== queryToken) return; // stale
  state.total = data.total;
  updateSpacerHeight();
  updateCount();
  render();
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    grandTotal = data.total;
    updateCount();
    renderBadges(data.bySeverity, data.total);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('stats failed', err);
  }
}

function renderBadges(bySeverity, grandTotal) {
  badgesEl.innerHTML = '';
  const totalBadge = document.createElement('span');
  totalBadge.className = 'badge';
  totalBadge.innerHTML = `total <b>${grandTotal.toLocaleString()}</b>`;
  badgesEl.appendChild(totalBadge);
  for (const sev of SEV_ORDER) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.innerHTML = `<span class="dot" style="background:var(--${sev})"></span>${sev} <b>${(
      bySeverity[sev] || 0
    ).toLocaleString()}</b>`;
    badgesEl.appendChild(b);
  }
}

// ---- Layout / virtualization ------------------------------------------
function updateSpacerHeight() {
  spacer.style.height = Math.max(state.total * ROW_H, 0) + 'px';
}

function updateCount() {
  const grand = grandTotal || state.total;
  countEl.textContent = `${state.total.toLocaleString()} of ${grand.toLocaleString()}`;
}

function fmtTs(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function acquireRow(i) {
  let el = rowPool[i];
  if (!el) {
    el = document.createElement('div');
    el.className = 'log-row';
    el.innerHTML =
      '<div class="col col-ts"></div>' +
      '<div class="col col-sev"></div>' +
      '<div class="col col-svc"></div>' +
      '<div class="col col-msg"></div>';
    rowPool[i] = el;
    rowsEl.appendChild(el);
  }
  return el;
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewportH = viewport.clientHeight;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(state.total, first + visibleCount);

  // Ensure the windows covering [first,last) are loaded.
  const firstWin = Math.floor(first / WINDOW);
  const lastWin = Math.floor(Math.max(first, last - 1) / WINDOW);
  for (let w = firstWin; w <= lastWin; w++) fetchWindow(w, queryToken);

  const needed = last - first;
  // Update / create pooled row elements.
  for (let i = 0; i < needed; i++) {
    const rowIndex = first + i;
    const el = acquireRow(i);
    const winIdx = Math.floor(rowIndex / WINDOW);
    const win = windows.get(winIdx);
    el.style.display = '';
    el.style.transform = `translateY(${rowIndex * ROW_H}px)`;

    const cells = el.children;
    if (win) {
      const row = win[rowIndex - winIdx * WINDOW];
      if (row) {
        el.dataset.severity = row.severity;
        cells[0].textContent = fmtTs(row.ts);
        cells[1].innerHTML = `<span class="sev-tag sev-${row.severity}">${row.severity}</span>`;
        cells[2].textContent = row.service;
        cells[3].textContent = row.message;
      } else {
        blankRow(cells);
      }
    } else {
      // Placeholder while loading; never leave permanently blank because
      // fetchWindow above will trigger a re-render on arrival.
      cells[0].innerHTML = '<span class="mono-dim">…</span>';
      cells[1].textContent = '';
      cells[2].textContent = '';
      cells[3].innerHTML = '<span class="mono-dim">loading…</span>';
    }
  }

  // Hide surplus pooled rows.
  for (let i = needed; i < rowPool.length; i++) {
    if (rowPool[i]) rowPool[i].style.display = 'none';
  }

  // Evict far-away windows to bound memory (keep a few around current).
  evictWindows(firstWin, lastWin);
}

function blankRow(cells) {
  cells[0].textContent = '';
  cells[1].textContent = '';
  cells[2].textContent = '';
  cells[3].textContent = '';
}

function evictWindows(firstWin, lastWin) {
  const keepFrom = firstWin - 2;
  const keepTo = lastWin + 2;
  for (const w of windows.keys()) {
    if (w < keepFrom || w > keepTo) windows.delete(w);
  }
}

// ---- Filter changes ----------------------------------------------------
function resetForNewQuery() {
  queryToken++;
  cancelInflight();
  windows = new Map();
  viewport.scrollTop = 0;
  state.total = 0;
  updateSpacerHeight();
  const token = queryToken;
  refreshTotal(token);
}

// ---- Events ------------------------------------------------------------
let scrollScheduled = false;
viewport.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    render();
  });
});

severityEl.addEventListener('change', () => {
  state.severity = severityEl.value;
  resetForNewQuery();
});

let searchDebounce = null;
searchEl.addEventListener('input', () => {
  const value = searchEl.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.q = value.trim();
    resetForNewQuery();
  }, 250);
});

window.addEventListener('resize', () => render());

// ---- Boot --------------------------------------------------------------
loadStats();
resetForNewQuery();
