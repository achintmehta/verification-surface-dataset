import './style.css';

const ROW_HEIGHT = 32;
const LIMIT = 200; // max window size the API allows; we fetch in windows
const OVERSCAN = 8; // extra rows above/below the viewport
const DEBOUNCE_MS = 200;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severitySelect = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');

// --- application state ---
const state = {
  total: 0,
  severity: '',
  q: '',
  // cache of fetched rows keyed by absolute offset -> row object
  cache: new Map(),
  // set of window start offsets currently being fetched
  inflightWindows: new Set(),
  // monotonic token; only the newest filter's responses may mutate the view
  filterToken: 0,
  // recycled row DOM nodes keyed by their current absolute index
  nodePool: [],
};

const dtFmt = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function formatTs(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return dtFmt.format(d).replace(',', '');
}

function severityBadge(sev) {
  return `<span class="sev-badge sev-${sev}">${sev}</span>`;
}

// -------------------------------------------------------------------------
// Data fetching
// -------------------------------------------------------------------------

function buildQuery(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return `/api/logs?${params.toString()}`;
}

// Fetch the window that covers a given start offset. Windows are aligned to
// LIMIT boundaries so caching is stable and de-duplicated.
async function fetchWindow(windowStart, token) {
  if (state.inflightWindows.has(windowStart)) return;
  if (state.total > 0 && windowStart >= state.total) return;
  state.inflightWindows.add(windowStart);

  // If total is unknown (initial load), request a full window. Otherwise clamp
  // to the remaining rows so we never over-request past the end.
  let limit = LIMIT;
  if (state.total > 0) {
    limit = Math.min(LIMIT, state.total - windowStart);
  }
  if (limit <= 0) {
    state.inflightWindows.delete(windowStart);
    return;
  }
  try {
    const res = await fetch(buildQuery(windowStart, limit));
    if (!res.ok) return;
    const data = await res.json();

    // Discard stale responses: a newer filter has superseded this one.
    if (token !== state.filterToken) return;

    // total may refine (shouldn't change mid-filter, but keep it authoritative)
    if (typeof data.total === 'number') {
      state.total = data.total;
      updateSpacer();
      updateCount();
    }

    data.rows.forEach((row, i) => {
      state.cache.set(windowStart + i, row);
    });
    render();
  } catch (_err) {
    // network error / aborted: leave the window to be retried on next scroll
  } finally {
    state.inflightWindows.delete(windowStart);
  }
}

// Ensure the windows covering [from, to) are loaded.
function ensureRange(from, to, token) {
  const first = Math.max(0, from);
  const last = Math.min(state.total, to);
  const firstWindow = Math.floor(first / LIMIT) * LIMIT;
  for (let w = firstWindow; w < last; w += LIMIT) {
    const covered = state.cache.has(w) && state.cache.has(Math.min(w + LIMIT, state.total) - 1);
    if (!covered) fetchWindow(w, token);
  }
}

// -------------------------------------------------------------------------
// Rendering / virtualization
// -------------------------------------------------------------------------

function updateSpacer() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateCount() {
  const { start, end } = visibleRange();
  const shown = Math.max(0, end - start);
  countEl.textContent = `${shown} of ${state.total.toLocaleString()}`;
}

function visibleRange() {
  const scrollTop = viewport.scrollTop;
  const height = viewport.clientHeight;
  const first = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  const visibleCount = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const start = Math.max(0, first);
  const end = Math.min(state.total, start + visibleCount);
  return { start, end };
}

function makeRowNode() {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-sev"></div>' +
    '<div class="col col-svc"></div>' +
    '<div class="col col-msg"></div>';
  return el;
}

function render() {
  const { start, end } = visibleRange();
  const needed = end - start;

  // Grow the node pool as needed.
  while (state.nodePool.length < needed) {
    const node = makeRowNode();
    state.nodePool.push(node);
    rowsEl.appendChild(node);
  }
  // Hide any extra nodes.
  for (let i = needed; i < state.nodePool.length; i++) {
    state.nodePool[i].style.display = 'none';
  }

  for (let i = 0; i < needed; i++) {
    const absIndex = start + i;
    const node = state.nodePool[i];
    node.style.display = '';
    node.style.transform = `translateY(${absIndex * ROW_HEIGHT}px)`;
    node.style.position = 'absolute';
    node.style.left = '0';
    node.style.right = '0';

    const row = state.cache.get(absIndex);
    const [tsCell, sevCell, svcCell, msgCell] = node.children;
    if (row) {
      node.classList.remove('empty');
      tsCell.textContent = formatTs(row.ts);
      sevCell.innerHTML = severityBadge(row.severity);
      svcCell.textContent = row.service;
      msgCell.textContent = row.message;
    } else {
      node.classList.add('empty');
      tsCell.textContent = '…';
      sevCell.textContent = '';
      svcCell.textContent = '';
      msgCell.textContent = 'loading…';
    }
  }

  updateCount();
}

function onScroll() {
  const { start, end } = visibleRange();
  ensureRange(start, end, state.filterToken);
  render();
}

// -------------------------------------------------------------------------
// Filters
// -------------------------------------------------------------------------

function resetForNewFilter() {
  state.filterToken += 1;
  state.cache.clear();
  state.inflightWindows.clear();
  state.total = 0;
  viewport.scrollTop = 0;
  updateSpacer();
  render();
  loadInitial(state.filterToken);
}

async function loadInitial(token) {
  // Fetch the first window; this also establishes `total`.
  await fetchWindow(0, token);
  if (token !== state.filterToken) return;
  const { start, end } = visibleRange();
  ensureRange(start, end, token);
  render();
}

let debounceTimer = null;
function onSearchInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const value = searchInput.value.trim();
    if (value === state.q) return;
    state.q = value;
    resetForNewFilter();
  }, DEBOUNCE_MS);
}

function onSeverityChange() {
  state.severity = severitySelect.value;
  resetForNewFilter();
}

// -------------------------------------------------------------------------
// Init
// -------------------------------------------------------------------------

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const stats = await res.json();
    // Annotate severity options with counts.
    for (const opt of severitySelect.options) {
      if (opt.value && stats.bySeverity[opt.value] !== undefined) {
        opt.textContent = `${opt.value} (${stats.bySeverity[opt.value].toLocaleString()})`;
      } else if (!opt.value) {
        opt.textContent = `All (${stats.total.toLocaleString()})`;
      }
    }
  } catch (_err) { /* non-fatal */ }
}

viewport.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', () => { render(); onScroll(); });
severitySelect.addEventListener('change', onSeverityChange);
searchInput.addEventListener('input', onSearchInput);

loadStats();
resetForNewFilter();
