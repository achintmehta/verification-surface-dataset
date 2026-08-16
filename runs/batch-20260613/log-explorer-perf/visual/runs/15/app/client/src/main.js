import './style.css';

const ROW_H = 30;             // must match --row-h in CSS
const WINDOW = 200;           // rows fetched per request (== server max limit)
const OVERSCAN = 20;          // extra rows rendered beyond viewport
// Browsers cap element height (~33.5M px in most engines). With 100k rows * 30px
// = 3M px we are safely below the cap, so a plain spacer works.

const els = {
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  badges: document.getElementById('badges'),
  status: document.getElementById('status'),
};

const state = {
  total: 0,
  severity: '',
  q: '',
  // Cache of fetched windows keyed by window start offset.
  cache: new Map(),
  // Set of window offsets that have an in-flight request.
  inflight: new Set(),
  // Monotonic token so stale (out-of-order) responses are discarded.
  requestToken: 0,
  // Token identifying the current filter generation.
  filterToken: 0,
};

function fmtTs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function windowStartFor(offset) {
  return Math.floor(offset / WINDOW) * WINDOW;
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

async function fetchWindow(startOffset, filterToken) {
  if (state.cache.has(startOffset) || state.inflight.has(startOffset)) return;
  state.inflight.add(startOffset);

  const params = new URLSearchParams({
    offset: String(startOffset),
    limit: String(WINDOW),
  });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const resp = await fetch(`/api/logs?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Discard if the filter generation changed while this was in flight.
    if (filterToken !== state.filterToken) return;

    state.cache.set(startOffset, data.rows);
    // Keep total fresh (should be stable within a filter generation).
    state.total = data.total;
    render();
  } catch (err) {
    if (filterToken === state.filterToken) {
      setStatus(`Query failed: ${err.message}`, true);
    }
  } finally {
    state.inflight.delete(startOffset);
  }
}

function ensureWindows(firstVisible, lastVisible) {
  const startWin = windowStartFor(Math.max(0, firstVisible));
  const endWin = windowStartFor(Math.max(0, lastVisible));
  for (let w = startWin; w <= endWin; w += WINDOW) {
    if (w < state.total || state.total === 0) {
      fetchWindow(w, state.filterToken);
    }
  }
  // Trim cache to a bounded set of windows near the viewport.
  const keep = new Set();
  for (let w = startWin - WINDOW; w <= endWin + WINDOW; w += WINDOW) keep.add(w);
  for (const key of state.cache.keys()) {
    if (!keep.has(key)) state.cache.delete(key);
  }
}

function getRow(offset) {
  const win = windowStartFor(offset);
  const rows = state.cache.get(win);
  if (!rows) return undefined;
  return rows[offset - win];
}

// Recycled row-element pool.
const pool = [];
function acquireRows(n) {
  while (pool.length < n) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<div class="col col-ts"></div>' +
      '<div class="col col-sev"><span class="sev"></span></div>' +
      '<div class="col col-svc"></div>' +
      '<div class="col col-msg"></div>';
    els.rows.appendChild(row);
    pool.push({
      root: row,
      ts: row.children[0],
      sevWrap: row.children[1],
      sev: row.children[1].firstChild,
      svc: row.children[2],
      msg: row.children[3],
    });
  }
  return pool;
}

function render() {
  const total = state.total;
  els.spacer.style.height = `${total * ROW_H}px`;

  const scrollTop = els.viewport.scrollTop;
  const viewportH = els.viewport.clientHeight;

  let first = Math.floor(scrollTop / ROW_H) - OVERSCAN;
  let last = Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN;
  first = Math.max(0, first);
  last = Math.min(total - 1, last);

  ensureWindows(first, last);

  const visibleCount = total === 0 ? 0 : last - first + 1;
  acquireRows(visibleCount);

  // Position and fill rows.
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (i >= visibleCount) {
      p.root.style.display = 'none';
      continue;
    }
    const offset = first + i;
    const data = getRow(offset);
    p.root.style.display = '';
    p.root.style.transform = `translateY(${offset * ROW_H}px)`;
    if (data) {
      p.ts.textContent = fmtTs(data.ts);
      p.sev.textContent = data.severity;
      p.sev.className = `sev ${data.severity}`;
      p.svc.textContent = data.service;
      p.msg.textContent = data.message;
      p.root.classList.remove('loading');
    } else {
      // Placeholder while the window loads — never a permanently blank region.
      p.ts.textContent = '…';
      p.sev.textContent = '';
      p.sev.className = 'sev';
      p.svc.textContent = '';
      p.msg.textContent = 'loading…';
    }
  }

  updateCount();
}

function updateCount() {
  const filtered = state.severity || state.q;
  els.count.innerHTML = filtered
    ? `<b>${state.total.toLocaleString()}</b> matching of ${state.baseTotal.toLocaleString()}`
    : `<b>${state.total.toLocaleString()}</b> of ${state.baseTotal.toLocaleString()}`;
}

function resetForNewFilter() {
  state.filterToken++;
  state.cache.clear();
  state.inflight.clear();
  els.viewport.scrollTop = 0;
  // Force a fresh total by fetching window 0 with a fresh generation.
  state.total = 0;
  render();
  fetchWindow(0, state.filterToken);
}

// --- Filter wiring ---

let searchTimer = null;
els.search.addEventListener('input', () => {
  // Never block input; debounce the query.
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = els.search.value.trim();
    resetForNewFilter();
  }, 200);
});

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  resetForNewFilter();
});

// --- Scroll wiring (rAF-throttled) ---
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

// --- Stats / badges ---
async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const data = await resp.json();
    state.baseTotal = data.total;
    const colors = { debug: 'var(--sev-debug)', info: 'var(--sev-info)', warn: 'var(--sev-warn)', error: 'var(--sev-error)' };
    els.badges.innerHTML = '';
    for (const sev of ['debug', 'info', 'warn', 'error']) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.innerHTML = `<span class="dot" style="background:${colors[sev]}"></span>${sev} <span class="n">${(data.bySeverity[sev] || 0).toLocaleString()}</span>`;
      els.badges.appendChild(b);
    }
    updateCount();
  } catch (err) {
    setStatus(`Failed to load stats: ${err.message}`, true);
  }
}

// --- Boot ---
async function boot() {
  state.baseTotal = 0;
  await loadStats();
  state.total = state.baseTotal;
  render();
  fetchWindow(0, state.filterToken);
  setStatus('Ready.');
}

boot();
