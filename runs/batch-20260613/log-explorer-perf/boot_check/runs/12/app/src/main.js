// Virtualized log explorer client.
//
// Core ideas:
//  - The scrollbar height reflects `total * ROW_HEIGHT`, but only the rows
//    intersecting the viewport (plus overscan) ever exist in the DOM.
//  - Rows are fetched window-by-window from the server and cached; a recycled
//    pool of row elements is repositioned as the user scrolls.
//  - Filter changes reset scroll and invalidate caches; stale responses are
//    dropped so out-of-order network completions never clobber newer results.

const ROW_HEIGHT = 28;
const OVERSCAN = 10; // extra rows above/below the viewport
const WINDOW_SIZE = 200; // rows fetched per request (server cap)
const DEBOUNCE_MS = 200;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const pool = document.getElementById('pool');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');

const state = {
  total: 0, // rows matching the current filter
  grandTotal: 0, // rows in the full corpus (unfiltered)
  severity: '',
  q: '',
  // Monotonic token identifying the current filter generation. Any response
  // tagged with an older token is ignored.
  filterToken: 0,
  // Cache of fetched rows keyed by absolute offset -> row object.
  rows: new Map(),
  // Windows currently being fetched, keyed by window start offset -> token.
  pending: new Map(),
  poolEls: [],
};

function buildQuery(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return '/api/logs?' + params.toString();
}

// Fetch the window that contains `offset`, aligned to WINDOW_SIZE boundaries.
async function ensureWindow(offset) {
  const winStart = Math.floor(offset / WINDOW_SIZE) * WINDOW_SIZE;
  if (state.rows.has(winStart)) return; // already cached (row 0 of window)
  if (state.pending.get(winStart) === state.filterToken) return; // in flight

  const token = state.filterToken;
  state.pending.set(winStart, token);

  try {
    const res = await fetch(buildQuery(winStart, WINDOW_SIZE));
    const data = await res.json();

    // Drop stale responses: if the filter changed since we issued this fetch,
    // ignore the result entirely.
    if (token !== state.filterToken) return;

    state.total = data.total;
    for (let i = 0; i < data.rows.length; i++) {
      state.rows.set(winStart + i, data.rows[i]);
    }
    updateCount();
    render();
  } catch (err) {
    // Network error: allow a retry by clearing the pending marker.
    console.error('fetch failed', err);
  } finally {
    if (state.pending.get(winStart) === token) {
      state.pending.delete(winStart);
    }
  }
}

function updateCount() {
  const gt = state.grandTotal || state.total;
  countEl.textContent = `${state.total.toLocaleString()} of ${gt.toLocaleString()}`;
}

function formatTs(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', ' UTC');
}

function makeRowEl() {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-sev"></div>' +
    '<div class="col col-svc"></div>' +
    '<div class="col col-msg"></div>';
  pool.appendChild(el);
  return el;
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewportH = viewport.clientHeight;

  // Set the total scroll height so the scrollbar reflects the full corpus.
  spacer.style.height = state.total * ROW_HEIGHT + 'px';

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT);

  let startIdx = Math.max(0, firstVisible - OVERSCAN);
  let endIdx = Math.min(state.total - 1, firstVisible + visibleCount + OVERSCAN);

  const needed = state.total === 0 ? 0 : endIdx - startIdx + 1;

  // Grow the recycled pool if needed.
  while (state.poolEls.length < needed) {
    state.poolEls.push(makeRowEl());
  }

  // Ensure all windows overlapping the visible range are loaded.
  if (state.total > 0) {
    for (let o = startIdx; o <= endIdx; o += WINDOW_SIZE) {
      ensureWindow(o);
    }
    ensureWindow(endIdx);
  }

  // Position and fill pool elements; hide the surplus.
  for (let i = 0; i < state.poolEls.length; i++) {
    const el = state.poolEls[i];
    const idx = startIdx + i;
    if (i >= needed || idx > endIdx) {
      el.style.display = 'none';
      continue;
    }
    el.style.display = 'flex';
    el.style.transform = `translateY(${idx * ROW_HEIGHT}px)`;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';

    const row = state.rows.get(idx);
    const [tsEl, sevEl, svcEl, msgEl] = el.children;
    if (row) {
      el.classList.remove('loading');
      tsEl.textContent = formatTs(row.ts);
      sevEl.innerHTML = `<span class="sev-badge sev-${row.severity}">${row.severity}</span>`;
      svcEl.textContent = row.service;
      msgEl.textContent = row.message;
      msgEl.title = row.message;
    } else {
      // Placeholder while the window loads.
      el.classList.add('loading');
      tsEl.textContent = '…';
      sevEl.innerHTML = '';
      svcEl.textContent = '';
      msgEl.textContent = '';
    }
  }
}

// --- Filter handling -------------------------------------------------------

function resetForNewFilter() {
  state.filterToken++;
  state.rows.clear();
  state.pending.clear();
  viewport.scrollTop = 0;
  // Fetch the first window immediately so total + rows populate.
  ensureWindow(0).then(render);
  render();
}

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  // Input is never blocked on a query: we only schedule work here.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    resetForNewFilter();
  }, DEBOUNCE_MS);
});

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  resetForNewFilter();
});

// Re-render on scroll (rAF-throttled to keep it smooth).
let scrollScheduled = false;
viewport.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    render();
  });
});

window.addEventListener('resize', render);

// --- Boot ------------------------------------------------------------------

async function boot() {
  // Load full-corpus stats for the "N of <grand total>" badge.
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    state.grandTotal = stats.total;
  } catch (err) {
    console.error('stats failed', err);
  }
  // Prime total + first window.
  await ensureWindow(0);
  render();
}

boot();
