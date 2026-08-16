// Virtualized log explorer.
// - Only rows intersecting the viewport (+ overscan) exist in the DOM.
// - The virtual scroll height equals total * rowHeight so the scrollbar maps 1:1 to offsets.
// - Windows are fetched on demand and cached; scrolling recycles DOM rows.
// - Search is debounced; stale/out-of-order responses never overwrite newer results.

const ROW_HEIGHT = 30; // must match --row-height in CSS
const OVERSCAN = 15; // extra rows above/below the viewport
const WINDOW_SIZE = 100; // rows fetched per API call (<= 200 server cap)
const DEBOUNCE_MS = 200;

const scroller = document.getElementById('scroller');
const spacer = document.getElementById('spacer');
const viewport = document.getElementById('viewport');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');

const state = {
  total: 0,
  severity: '',
  q: '',
  // Cache of fetched rows keyed by absolute offset. Map<offset, rowObject>.
  rows: new Map(),
  // Which windows (by window-start offset) have been requested for the current filter.
  requestedWindows: new Set(),
  // Monotonic token: each filter change increments it; responses tagged with an older
  // token are discarded so out-of-order responses never win.
  filterToken: 0,
  // Per-window fetch tokens (also validated against filterToken).
};

function fmtTs(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function apiUrl(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return `/api/logs?${params.toString()}`;
}

// Reset everything when the filter changes.
function resetForFilterChange() {
  state.filterToken += 1;
  state.rows.clear();
  state.requestedWindows.clear();
  scroller.scrollTop = 0;
}

async function refreshFilter() {
  const token = state.filterToken;
  // Fetch the first window; the response also carries the authoritative total.
  try {
    const resp = await fetch(apiUrl(0, WINDOW_SIZE));
    if (token !== state.filterToken) return; // stale
    if (!resp.ok) return;
    const data = await resp.json();
    if (token !== state.filterToken) return; // stale (checked again after await)

    state.total = data.total;
    storeWindow(0, data.rows);
    state.requestedWindows.add(0);
    updateCount();
    updateSpacerHeight();
    render();
  } catch (_) {
    /* aborted / network error — ignored */
  }
}

function storeWindow(offset, rows) {
  for (let i = 0; i < rows.length; i++) {
    state.rows.set(offset + i, rows[i]);
  }
}

function updateSpacerHeight() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateCount() {
  countEl.textContent = `${state.total.toLocaleString()} of ${state.total.toLocaleString()}`;
}

// Round an offset down to the nearest window boundary.
function windowStartFor(offset) {
  return Math.floor(offset / WINDOW_SIZE) * WINDOW_SIZE;
}

async function ensureWindow(windowStart) {
  if (windowStart < 0 || windowStart >= state.total) return;
  if (state.requestedWindows.has(windowStart)) return;
  state.requestedWindows.add(windowStart);

  const token = state.filterToken;
  try {
    const resp = await fetch(apiUrl(windowStart, WINDOW_SIZE));
    if (token !== state.filterToken) return; // stale filter
    if (!resp.ok) {
      state.requestedWindows.delete(windowStart);
      return;
    }
    const data = await resp.json();
    if (token !== state.filterToken) return; // stale filter
    storeWindow(windowStart, data.rows);
    render();
  } catch (_) {
    state.requestedWindows.delete(windowStart);
  }
}

let visibleStart = 0;

function makeRowEl() {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML =
    '<div class="cell col-ts"></div>' +
    '<div class="cell col-sev"></div>' +
    '<div class="cell col-svc"></div>' +
    '<div class="cell col-msg"></div>';
  return row;
}

function render() {
  const scrollTop = scroller.scrollTop;
  const viewH = scroller.clientHeight;

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewH / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(state.total, first + visibleCount);
  visibleStart = first;

  const needed = last - first;

  // Ensure DOM pool has exactly `needed` rows.
  while (viewport.children.length < needed) {
    viewport.appendChild(makeRowEl());
  }
  while (viewport.children.length > needed) {
    viewport.removeChild(viewport.lastChild);
  }

  // Position the viewport container at the first visible row.
  viewport.style.transform = `translateY(${first * ROW_HEIGHT}px)`;

  // Determine which windows we need and request any missing ones.
  const neededWindows = new Set();
  neededWindows.add(windowStartFor(first));
  neededWindows.add(windowStartFor(Math.max(first, last - 1)));
  for (const w of neededWindows) ensureWindow(w);

  // Fill DOM rows.
  for (let i = 0; i < needed; i++) {
    const index = first + i;
    const el = viewport.children[i];
    const data = state.rows.get(index);
    const cells = el.children;
    if (data) {
      el.classList.remove('loading');
      cells[0].textContent = fmtTs(data.ts);
      cells[1].innerHTML = `<span class="badge ${data.severity}">${data.severity}</span>`;
      cells[2].textContent = data.service;
      cells[3].textContent = data.message;
    } else {
      el.classList.add('loading');
      cells[0].textContent = '…';
      cells[1].textContent = '';
      cells[2].textContent = '';
      cells[3].textContent = '';
    }
  }
}

// Prune the row cache so memory stays bounded regardless of scroll extent.
function pruneCache() {
  const keepFrom = windowStartFor(visibleStart) - WINDOW_SIZE * 4;
  const keepTo = windowStartFor(visibleStart) + WINDOW_SIZE * 5;
  for (const key of state.rows.keys()) {
    if (key < keepFrom || key > keepTo) {
      state.rows.delete(key);
    }
  }
  for (const w of state.requestedWindows) {
    if (w < keepFrom || w > keepTo) {
      state.requestedWindows.delete(w);
    }
  }
}

let scrollRaf = 0;
scroller.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    render();
    pruneCache();
  });
});

window.addEventListener('resize', () => render());

// ---- Filter controls ----

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  resetForFilterChange();
  refreshFilter();
});

let debounceTimer = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    resetForFilterChange();
    refreshFilter();
  }, DEBOUNCE_MS);
});

// ---- Initial load ----
async function init() {
  try {
    const statsResp = await fetch('/api/stats');
    if (statsResp.ok) {
      const stats = await statsResp.json();
      // Annotate severity dropdown options with per-severity counts.
      for (const opt of severitySel.options) {
        if (opt.value && stats.bySeverity[opt.value] != null) {
          opt.textContent = `${opt.value} (${stats.bySeverity[opt.value].toLocaleString()})`;
        } else if (!opt.value) {
          opt.textContent = `all (${stats.total.toLocaleString()})`;
        }
      }
    }
  } catch (_) {
    /* stats optional */
  }
  await refreshFilter();
}

init();
