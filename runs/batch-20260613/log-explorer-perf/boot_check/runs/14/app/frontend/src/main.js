// Virtualized log explorer client.
//
// Design:
// - The viewport scrolls a spacer sized to total * ROW_HEIGHT, so the
//   scrollbar reflects the entire filtered corpus without rendering it.
// - Only rows intersecting the viewport (plus overscan) exist in the DOM.
// - Rows are fetched window-by-window from the server and cached; a small
//   LRU-ish cache keeps recently seen windows so scrolling is smooth.
// - Filter changes reset scroll, refetch total, and re-render. A monotonic
//   request token guarantees stale responses never overwrite newer state.

const API = (import.meta.env && import.meta.env.VITE_API) || 'http://localhost:3001';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;      // extra rows above/below viewport
const WINDOW_SIZE = 100;  // server fetch page size (<= 200 cap)
const MAX_CACHED_WINDOWS = 40;

const els = {
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  badges: document.getElementById('badges'),
};

const state = {
  total: 0,
  severity: '',
  q: '',
  corpusTotal: 0,
  // cache: window index -> { rows: [...], startOffset }
  cache: new Map(),
  // set of window indices currently being fetched
  inFlight: new Set(),
  // increments on every filter change; used to discard stale responses
  filterToken: 0,
};

function windowIndexForOffset(offset) {
  return Math.floor(offset / WINDOW_SIZE);
}

function buildQuery(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return params.toString();
}

// Fetch a window of rows. Tagged with the filter token active at issue time;
// results are ignored if the filter has changed since.
async function fetchWindow(windowIdx, token) {
  if (state.cache.has(windowIdx) || state.inFlight.has(windowIdx)) return;
  state.inFlight.add(windowIdx);
  const offset = windowIdx * WINDOW_SIZE;
  try {
    const resp = await fetch(`${API}/api/logs?${buildQuery(offset, WINDOW_SIZE)}`);
    if (token !== state.filterToken) return; // stale: filter changed
    if (!resp.ok) return;
    const data = await resp.json();
    if (token !== state.filterToken) return; // stale after await
    state.cache.set(windowIdx, { rows: data.rows, startOffset: offset });
    evictCache();
    render();
  } catch (e) {
    // network/abort errors are non-fatal; the window will be retried on scroll
  } finally {
    state.inFlight.delete(windowIdx);
  }
}

function evictCache() {
  if (state.cache.size <= MAX_CACHED_WINDOWS) return;
  // Evict windows farthest from the current viewport.
  const scrollTop = els.viewport.scrollTop;
  const centerOffset = scrollTop / ROW_HEIGHT + (els.viewport.clientHeight / ROW_HEIGHT) / 2;
  const centerWindow = centerOffset / WINDOW_SIZE;
  const entries = [...state.cache.keys()].sort(
    (a, b) => Math.abs(b - centerWindow) - Math.abs(a - centerWindow)
  );
  while (state.cache.size > MAX_CACHED_WINDOWS) {
    const victim = entries.shift();
    if (victim === undefined) break;
    state.cache.delete(victim);
  }
}

function sevTag(sev) {
  return `<span class="sev-tag sev-${sev}">${sev}</span>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTs(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function getRowAtOffset(offset) {
  const widx = windowIndexForOffset(offset);
  const win = state.cache.get(widx);
  if (!win) return undefined;
  return win.rows[offset - win.startOffset];
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
  const total = state.total;
  els.spacer.style.height = (total * ROW_HEIGHT) + 'px';

  const scrollTop = els.viewport.scrollTop;
  const viewH = els.viewport.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewH / ROW_HEIGHT);

  const startIdx = Math.max(0, firstVisible - OVERSCAN);
  const endIdx = Math.min(total, firstVisible + visibleCount + OVERSCAN);

  // Ensure the windows covering [startIdx, endIdx) are fetched.
  if (total > 0) {
    const firstWin = windowIndexForOffset(startIdx);
    const lastWin = windowIndexForOffset(Math.max(startIdx, endIdx - 1));
    for (let w = firstWin; w <= lastWin; w++) {
      if (!state.cache.has(w)) fetchWindow(w, state.filterToken);
    }
  }

  els.rows.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;

  let html = '';
  for (let i = startIdx; i < endIdx; i++) {
    const row = getRowAtOffset(i);
    if (row) {
      html +=
        `<div class="log-row">` +
        `<div class="col col-ts">${escapeHtml(formatTs(row.ts))}</div>` +
        `<div class="col col-sev">${sevTag(row.severity)}</div>` +
        `<div class="col col-svc">${escapeHtml(row.service)}</div>` +
        `<div class="col col-msg">${escapeHtml(row.message)}</div>` +
        `</div>`;
    } else {
      html +=
        `<div class="log-row">` +
        `<div class="col col-ts">…</div>` +
        `<div class="col col-sev"></div>` +
        `<div class="col col-svc"></div>` +
        `<div class="col col-msg"></div>` +
        `</div>`;
    }
  }
  els.rows.innerHTML = html;

  updateCount();
}

function updateCount() {
  const corpus = state.corpusTotal || state.total;
  els.count.textContent =
    `${state.total.toLocaleString()} of ${corpus.toLocaleString()}`;
}

// Reset all view state when filters change and fetch a fresh total.
async function applyFilters() {
  state.filterToken += 1;
  const token = state.filterToken;
  state.cache.clear();
  state.inFlight.clear();
  els.viewport.scrollTop = 0;

  try {
    const resp = await fetch(`${API}/api/logs?${buildQuery(0, WINDOW_SIZE)}`);
    if (token !== state.filterToken) return;
    if (!resp.ok) {
      state.total = 0;
      render();
      return;
    }
    const data = await resp.json();
    if (token !== state.filterToken) return;
    state.total = data.total;
    state.cache.set(0, { rows: data.rows, startOffset: 0 });
    render();
  } catch (e) {
    state.total = 0;
    render();
  }
}

async function loadStats() {
  try {
    const resp = await fetch(`${API}/api/stats`);
    if (!resp.ok) return;
    const data = await resp.json();
    state.corpusTotal = data.total;
    updateCount();
    const order = ['debug', 'info', 'warn', 'error'];
    els.badges.innerHTML =
      `<span class="badge">total ${data.total.toLocaleString()}</span>` +
      order
        .map(
          (s) =>
            `<span class="badge"><span class="sev-tag sev-${s}">${s}</span> ${(
              data.bySeverity[s] || 0
            ).toLocaleString()}</span>`
        )
        .join('');
  } catch (e) {
    // stats are non-critical
  }
}

// --- Event wiring ---

els.viewport.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender);

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  applyFilters();
});

let searchTimer = null;
els.search.addEventListener('input', () => {
  // Input is never blocked: we only schedule a debounced fetch.
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = els.search.value.trim();
    applyFilters();
  }, 250);
});

// Initial load
loadStats();
applyFilters();
