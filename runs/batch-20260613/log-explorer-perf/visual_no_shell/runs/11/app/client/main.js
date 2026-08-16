const ROW_H = 32;
const WINDOW = 100; // rows fetched per API call (<= 200 cap)
const OVERSCAN = 20; // extra rows above/below the viewport

const scroller = document.getElementById('scroller');
const spacer = document.getElementById('spacer');
const viewport = document.getElementById('viewport');
const countEl = document.getElementById('count');
const badgesEl = document.getElementById('badges');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');

// ---- state ----
let total = 0;
let filters = { severity: '', q: '' };
// Cache of fetched rows keyed by absolute offset -> row object.
let cache = new Map();
// Which windows are in flight, keyed by window start offset.
let inflight = new Set();
// Monotonic token so stale fetches never overwrite state after a filter change.
let filterToken = 0;
// Recycled DOM row pool.
const pool = [];

const sevClass = {
  debug: 'sev-debug',
  info: 'sev-info',
  warn: 'sev-warn',
  error: 'sev-error',
};

function fmtTs(iso) {
  const d = new Date(iso);
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

function windowStartFor(offset) {
  return Math.floor(offset / WINDOW) * WINDOW;
}

// Fetch a window of rows for the current filters. Guarded against staleness by
// capturing the filter token; also cancels via AbortController on filter change.
let controllers = new Map();

async function fetchWindow(start, token) {
  if (token !== filterToken) return;
  if (start < 0) return;
  // total may be 0 before the first fetch of a new filter; only guard against
  // requesting windows that are known to be past the end of the corpus.
  if (total > 0 && start >= total) return;
  if (inflight.has(start)) return;
  if (cache.has(start)) return; // first row of window already present
  inflight.add(start);

  const ac = new AbortController();
  controllers.set(start, ac);

  const params = new URLSearchParams({
    offset: String(start),
    limit: String(WINDOW),
  });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);

  try {
    const res = await fetch(`/api/logs?${params.toString()}`, { signal: ac.signal });
    if (!res.ok) throw new Error('bad response ' + res.status);
    const data = await res.json();
    // Discard if a newer filter has superseded this request.
    if (token !== filterToken) return;
    total = data.total;
    for (let i = 0; i < data.rows.length; i++) {
      cache.set(start + i, data.rows[i]);
    }
    render();
  } catch (err) {
    if (err.name !== 'AbortError') console.error('fetchWindow failed', err);
  } finally {
    inflight.delete(start);
    controllers.delete(start);
  }
}

function abortAllInflight() {
  for (const ac of controllers.values()) ac.abort();
  controllers.clear();
  inflight.clear();
}

// Ensure the windows covering [from, to) are requested.
function ensureRange(from, to) {
  const token = filterToken;
  const firstWin = windowStartFor(Math.max(0, from));
  const lastWin = windowStartFor(Math.max(0, to - 1));
  for (let w = firstWin; w <= lastWin; w += WINDOW) {
    if (!cache.has(w) && !inflight.has(w)) fetchWindow(w, token);
  }
}

function acquireRow() {
  let el = pool.find((r) => r._free);
  if (!el) {
    el = document.createElement('div');
    el.className = 'row';
    el.innerHTML =
      '<div class="col col-ts"></div>' +
      '<div class="col col-sev"></div>' +
      '<div class="col col-svc"></div>' +
      '<div class="col col-msg"></div>';
    el._ts = el.children[0];
    el._sev = el.children[1];
    el._svc = el.children[2];
    el._msg = el.children[3];
    viewport.appendChild(el);
    pool.push(el);
  }
  el._free = false;
  el.style.display = 'flex';
  return el;
}

function releaseUnused() {
  // Any pooled row not touched during this render is recycled (hidden + freed).
  for (const el of pool) {
    if (el._usedThisRender) {
      el._usedThisRender = false;
    } else {
      el._free = true;
      el.style.display = 'none';
    }
  }
}

function render() {
  spacer.style.height = total * ROW_H + 'px';

  const scrollTop = scroller.scrollTop;
  const viewH = scroller.clientHeight;

  let first = Math.floor(scrollTop / ROW_H) - OVERSCAN;
  let last = Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN;
  first = Math.max(0, first);
  last = Math.min(total, last);

  ensureRange(first, last);

  // Position rows absolutely; recycle pool elements.
  for (let i = first; i < last; i++) {
    const row = cache.get(i);
    const el = acquireRow();
    el._usedThisRender = true;
    el.style.transform = `translateY(${i * ROW_H}px)`;
    if (row) {
      el.classList.remove('loading');
      el._ts.textContent = fmtTs(row.ts);
      el._sev.innerHTML = `<span class="sev-tag ${sevClass[row.severity]}">${row.severity}</span>`;
      el._svc.textContent = row.service;
      el._msg.textContent = row.message;
    } else {
      el.classList.add('loading');
      el._ts.textContent = '';
      el._sev.textContent = '';
      el._svc.textContent = '';
      el._msg.textContent = '…';
    }
  }
  releaseUnused();

  // update count
  const shown = Math.min(total, last) - first;
  countEl.innerHTML = `<b>${total.toLocaleString()}</b> matching rows`;
}

// ---- filters ----
function applyFilters(next) {
  filters = next;
  filterToken++;
  abortAllInflight();
  cache = new Map();
  total = 0;
  scroller.scrollTop = 0;
  // Kick an immediate fetch of the top window; render placeholders meanwhile.
  const token = filterToken;
  fetchWindow(0, token).then(() => render());
  render();
}

let debounceTimer = null;
function onSearchInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    applyFilters({ severity: severityEl.value, q: searchEl.value.trim() });
  }, 220);
}

severityEl.addEventListener('change', () => {
  applyFilters({ severity: severityEl.value, q: searchEl.value.trim() });
});
searchEl.addEventListener('input', onSearchInput);

// ---- scroll ----
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

// ---- stats / badges ----
const SEV_COLORS = {
  debug: '#9ca3af',
  info: '#7fb0ff',
  warn: '#f5c464',
  error: '#ff8a8a',
};

async function loadStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error('stats ' + res.status);
  const data = await res.json();
  badgesEl.innerHTML = '';
  const totalBadge = document.createElement('div');
  totalBadge.className = 'badge';
  totalBadge.innerHTML = `Total <b>${data.total.toLocaleString()}</b>`;
  badgesEl.appendChild(totalBadge);
  for (const sev of ['error', 'warn', 'info', 'debug']) {
    const b = document.createElement('div');
    b.className = 'badge';
    b.innerHTML =
      `<span class="dot" style="background:${SEV_COLORS[sev]}"></span>` +
      `${sev} <b>${(data.bySeverity[sev] || 0).toLocaleString()}</b>`;
    badgesEl.appendChild(b);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- boot ----
// The server may still be seeding on first boot; retry until it responds.
async function boot() {
  for (let attempt = 0; ; attempt++) {
    try {
      await loadStats();
      break;
    } catch (err) {
      if (attempt >= 60) {
        console.error('stats failed after retries', err);
        break;
      }
      await sleep(1000);
    }
  }
  applyFilters({ severity: '', q: '' });
}
boot();
