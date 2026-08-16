// Virtualized log explorer client.
// Only the rows intersecting the viewport (+ overscan) exist in the DOM.

const ROW_HEIGHT = 32;
const OVERSCAN = 10; // rows above/below viewport
const PAGE_LIMIT = 200; // server cap; we fetch windows sized to viewport
const DEBOUNCE_MS = 200;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');

const state = {
  total: 0,
  severity: '',
  q: '',
  // Cache of fetched rows keyed by absolute offset.
  cache: new Map(), // offset -> row
  // Track which windows are in-flight to avoid duplicate fetches.
  pending: new Set(), // window start offsets
  // Monotonic token so stale responses never overwrite newer state.
  filterToken: 0,
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

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function updateCount() {
  const base = state.baseTotal != null ? state.baseTotal : state.total;
  countEl.textContent = `${state.total.toLocaleString()} of ${base.toLocaleString()}`;
}

// Compute the window (aligned to PAGE_LIMIT) that a given offset lives in.
function windowStart(offset) {
  return Math.floor(offset / PAGE_LIMIT) * PAGE_LIMIT;
}

async function fetchWindow(startOffset, token) {
  if (state.pending.has(startOffset)) return;
  if (startOffset >= state.total) return;
  // Already fully cached?
  let allCached = true;
  const end = Math.min(startOffset + PAGE_LIMIT, state.total);
  for (let i = startOffset; i < end; i++) {
    if (!state.cache.has(i)) { allCached = false; break; }
  }
  if (allCached) return;

  state.pending.add(startOffset);
  const params = new URLSearchParams();
  params.set('offset', String(startOffset));
  params.set('limit', String(PAGE_LIMIT));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const resp = await fetch('/api/logs?' + params.toString());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    // Discard stale responses.
    if (token !== state.filterToken) return;
    data.rows.forEach((row, i) => {
      state.cache.set(startOffset + i, row);
    });
    render();
  } catch (e) {
    // Network error: allow retry later.
    console.warn('fetchWindow failed', e);
  } finally {
    state.pending.delete(startOffset);
  }
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewH = viewport.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewH / ROW_HEIGHT);

  let start = Math.max(0, firstVisible - OVERSCAN);
  let end = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);

  // Ensure the windows covering [start, end) are fetched.
  const token = state.filterToken;
  for (let ws = windowStart(start); ws < end; ws += PAGE_LIMIT) {
    fetchWindow(ws, token);
  }

  // Position the rows container at the correct offset.
  rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

  // Build DOM for visible range, recycling nodes.
  const needed = end - start;
  const children = rowsEl.children;

  // Adjust pool size.
  while (children.length < needed) {
    const div = document.createElement('div');
    div.className = 'log-row';
    div.innerHTML =
      '<div class="col col-ts"></div>' +
      '<div class="col col-sev"></div>' +
      '<div class="col col-svc"></div>' +
      '<div class="col col-msg"></div>';
    rowsEl.appendChild(div);
  }
  while (children.length > needed) {
    rowsEl.removeChild(rowsEl.lastChild);
  }

  for (let i = 0; i < needed; i++) {
    const offset = start + i;
    const node = children[i];
    const row = state.cache.get(offset);
    const cells = node.children;
    if (row) {
      cells[0].textContent = fmtTs(row.ts);
      cells[1].innerHTML = `<span class="sev-badge sev-${row.severity}">${row.severity}</span>`;
      cells[2].textContent = row.service;
      cells[3].textContent = row.message;
      node.style.opacity = '1';
    } else {
      // Placeholder while the window loads.
      cells[0].textContent = '';
      cells[1].innerHTML = '';
      cells[2].textContent = '';
      cells[3].textContent = '…';
      node.style.opacity = '0.4';
    }
  }
}

function resetForFilter() {
  state.filterToken++;
  state.cache.clear();
  state.pending.clear();
  viewport.scrollTop = 0;
}

async function loadTotalAndRender() {
  const token = ++state.filterToken;
  state.cache.clear();
  state.pending.clear();
  viewport.scrollTop = 0;

  const params = new URLSearchParams();
  params.set('offset', '0');
  params.set('limit', String(PAGE_LIMIT));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const resp = await fetch('/api/logs?' + params.toString());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (token !== state.filterToken) return; // stale
    state.total = data.total;
    data.rows.forEach((row, i) => state.cache.set(i, row));

    // Size the scrollbar.
    spacer.style.height = (state.total * ROW_HEIGHT) + 'px';
    emptyEl.hidden = state.total > 0;
    updateCount();
    render();
  } catch (e) {
    console.warn('loadTotalAndRender failed', e);
  }
}

// --- Stats for the "N of total" baseline ---
async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const data = await resp.json();
    state.baseTotal = data.total;
    updateCount();
  } catch (e) {
    console.warn('stats failed', e);
  }
}

// --- Events ---
let scrollRaf = null;
viewport.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    render();
  });
});

window.addEventListener('resize', () => render());

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  loadTotalAndRender();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const value = searchInput.value;
  debounceTimer = setTimeout(() => {
    state.q = value.trim();
    loadTotalAndRender();
  }, DEBOUNCE_MS);
});

// --- Boot ---
loadStats();
loadTotalAndRender();
